// App state: saved backends (in the Keychain / Keystore) and the two long-poll
// feeds (conversation list, one conversation's turns). Feeds pause while the
// app is in the background and resume at once when it comes back.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'backend.dart';
import 'models.dart';

abstract class ProfileStore {
  Future<({List<Profile> profiles, String current})> load();
  Future<void> save(List<Profile> profiles, String current);
}

/// Profiles hold device tokens, so all of them live in secure storage.
class SecureProfileStore implements ProfileStore {
  static const _storage = FlutterSecureStorage();
  @override
  Future<({List<Profile> profiles, String current})> load() async {
    try {
      final raw = jsonDecode(await _storage.read(key: 'profiles') ?? '{}') as Map<String, dynamic>;
      final profiles = (raw['profiles'] as List? ?? const []).whereType<Map>().map((item) => Profile.fromJson(item.cast<String, dynamic>())).toList();
      return (profiles: profiles, current: raw['current'] as String? ?? '');
    } catch (_) {
      return (profiles: <Profile>[], current: '');
    }
  }

  @override
  Future<void> save(List<Profile> profiles, String current) =>
      _storage.write(key: 'profiles', value: jsonEncode({'profiles': profiles.map((item) => item.toJson()).toList(), 'current': current}));
}

class MemoryProfileStore implements ProfileStore {
  MemoryProfileStore([List<Profile>? profiles]) : profiles = profiles ?? [];
  List<Profile> profiles;
  String current = '';
  @override
  Future<({List<Profile> profiles, String current})> load() async => (profiles: [...profiles], current: current);
  @override
  Future<void> save(List<Profile> profiles, String current) async {
    this.profiles = [...profiles];
    this.current = current;
  }
}

typedef ClientFactory = BackendClient Function(Profile profile);

class AppState extends ChangeNotifier {
  AppState({required this.store, ClientFactory? clientFactory}) : _factory = clientFactory ?? ((profile) => BackendClient(profile));
  final ProfileStore store;
  final ClientFactory _factory;
  List<Profile> profiles = [];
  Profile? current;
  BackendClient? client;
  bool loaded = false;

  Future<void> load() async {
    final saved = await store.load();
    profiles = saved.profiles;
    _select(profiles.where((item) => item.id == saved.current).firstOrNull ?? profiles.firstOrNull);
    loaded = true;
    notifyListeners();
  }

  void _select(Profile? profile) {
    client?.close();
    current = profile;
    client = profile == null ? null : _factory(profile);
  }

  /// Adds (or replaces, by token) a backend after checking it answers, then switches to it.
  Future<void> add(Profile profile) async {
    final candidate = _factory(profile);
    try {
      await candidate.connect();
    } finally {
      candidate.close();
    }
    final existing = profiles.indexWhere((item) => item.token == profile.token);
    profiles = [...profiles];
    if (existing >= 0) {
      profiles[existing] = profile;
    } else {
      profiles.add(profile);
    }
    _select(profile);
    await store.save(profiles, profile.id);
    notifyListeners();
  }

  Future<void> switchTo(Profile profile) async {
    _select(profile);
    await store.save(profiles, profile.id);
    notifyListeners();
  }

  Future<void> update(Profile profile) async {
    profiles = [for (final item in profiles) item.id == profile.id ? profile : item];
    if (current?.id == profile.id) _select(profile);
    await store.save(profiles, current?.id ?? '');
    notifyListeners();
  }

  Future<void> remove(Profile profile) async {
    profiles = profiles.where((item) => item.id != profile.id).toList();
    if (current?.id == profile.id) _select(profiles.firstOrNull);
    await store.save(profiles, current?.id ?? '');
    notifyListeners();
  }
}

/// Runs a long-poll loop: `step` waits for one change. Errors back off from 1 s to 30 s.
abstract class Feed extends ChangeNotifier {
  bool _running = false;
  int _generation = 0;
  String? error;
  bool unauthorized = false;

  Future<void> step();

  void start() {
    if (_running) return;
    _running = true;
    final generation = ++_generation;
    unawaited(_loop(generation));
  }

  void stop() {
    _running = false;
    _generation++;
  }

  bool isCurrent(int generation) => _running && generation == _generation;

  Future<void> _loop(int generation) async {
    var delay = const Duration(seconds: 1);
    while (isCurrent(generation)) {
      try {
        await step();
        if (!isCurrent(generation)) return;
        if (error != null) {
          error = null;
          notifyListeners();
        }
        delay = const Duration(seconds: 1);
      } on BackendError catch (failure) {
        if (!isCurrent(generation)) return;
        error = failure.message;
        unauthorized = failure.unauthorized;
        notifyListeners();
        if (unauthorized) {
          _running = false;
          return;
        }
        await Future<void>.delayed(delay);
        delay = Duration(milliseconds: min(delay.inMilliseconds * 2, 30000));
      }
    }
  }

  @override
  void dispose() {
    stop();
    super.dispose();
  }
}

class ConversationFeed extends Feed {
  ConversationFeed(this.client, {this.wait = const Duration(seconds: 25)});
  final BackendClient client;
  final Duration wait;
  String _etag = '';
  List<Conversation> conversations = [];
  List<Project> projects = [];
  bool loaded = false;
  DateTime _projectsAt = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  Future<void> step() async {
    // Project states (container running or not) change rarely; refresh them at most every 20 s.
    if (DateTime.now().difference(_projectsAt) > const Duration(seconds: 20)) {
      projects = await client.projects();
      _projectsAt = DateTime.now();
      if (loaded) notifyListeners();
    }
    final changes = await client.conversationChanges(_etag, wait: loaded ? wait : Duration.zero);
    if (changes == null) return;
    _etag = changes.etag;
    conversations = changes.conversations;
    loaded = true;
    notifyListeners();
  }

  /// Asks for the whole list on the next step, even when it has not changed.
  void resync() => _etag = '';

  Future<void> refreshProjects() async {
    projects = await client.projects();
    _projectsAt = DateTime.now();
    notifyListeners();
  }

  Project? project(String id) => projects.where((item) => item.id == id).firstOrNull;
}

class ChatFeed extends Feed {
  ChatFeed(this.client, this.conversationId, {this.wait = const Duration(seconds: 25), this.pace = const Duration(milliseconds: 250)});
  final BackendClient client;
  final String conversationId;
  final Duration wait, pace;
  String _etag = '';
  final Map<String, Turn> _turns = {};
  List<String> _order = [];
  List<FollowUp> followUps = [];
  bool loaded = false;

  List<Turn> get turns => [for (final id in _order) if (_turns[id] != null) _turns[id]!];
  Turn? get activeTurn => turns.where((turn) => turn.active).firstOrNull;

  @override
  Future<void> step() async {
    final changes = await client.turnChanges(conversationId, _etag, wait: loaded ? wait : Duration.zero);
    if (changes.unchanged) return;
    if (changes.full) _turns.clear();
    for (final turn in changes.turns) {
      _turns[turn.id] = turn;
    }
    _order = changes.order;
    _turns.removeWhere((id, _) => !_order.contains(id));
    followUps = changes.followUps;
    _etag = changes.etag;
    loaded = true;
    notifyListeners();
    // While an answer streams, changes come many times a second: batch them a little.
    if (activeTurn != null) await Future<void>.delayed(pace);
  }

  /// Asks for everything again on the next step (after sending, so the new turn shows at once).
  void poke() {
    stop();
    start();
  }
}
