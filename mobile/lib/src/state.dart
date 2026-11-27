// App state: saved backends (in the Keychain / Keystore) and the two long-poll
// feeds (conversation list, one conversation's turns). Feeds pause while the
// app is in the background and resume at once when it comes back. Both follow
// only what is on screen: a page of the list, the latest turns of a conversation;
// the rest is fetched as the user scrolls.
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
  /// Conversations asked for at first, and added each time the list is scrolled to its end.
  static const page = 30;
  String _etag = '';
  List<Conversation> conversations = [];
  List<Project> projects = [];
  bool loaded = false;
  DateTime _projectsAt = DateTime.fromMillisecondsSinceEpoch(0);
  int _limit = page;
  /// Conversations on the backend (matching [query]); [conversations] holds the most recent of them.
  int total = 0;
  /// What the list is searched for ('' = everything), lower case.
  String query = '';
  /// The answer on screen is for an earlier page size or search; the new one is on its way.
  bool pending = false;

  bool get hasMore => conversations.length < total;

  /// Asks for one more page (when the list is scrolled to its end).
  void loadMore() {
    if (!hasMore || pending) return;
    _limit += page;
    _ask();
  }

  /// Searches names and projects on the backend; '' shows everything again.
  void search(String value) {
    if (value == query) return;
    query = value;
    _limit = page;
    _ask();
  }

  void _ask() {
    pending = true;
    notifyListeners();
    // The poll in flight asks for the old page: start a new one.
    if (_running) {
      stop();
      start();
    }
  }

  @override
  Future<void> step() async {
    // Project states (container running or not) change rarely; refresh them at most every 20 s.
    if (DateTime.now().difference(_projectsAt) > const Duration(seconds: 20)) {
      projects = await client.projects();
      _projectsAt = DateTime.now();
      if (loaded) notifyListeners();
    }
    final limit = _limit, query = this.query;
    final changes = await client.conversationChanges(_etag, wait: loaded && !pending ? wait : Duration.zero, limit: limit, query: query);
    // An answer to a question no longer asked (the page grew, the search changed) is dropped.
    if (limit != _limit || query != this.query) return;
    if (changes == null) {
      if (pending) {
        pending = false;
        notifyListeners();
      }
      return;
    }
    _etag = changes.etag;
    conversations = changes.conversations;
    total = changes.total;
    pending = false;
    loaded = true;
    notifyListeners();
  }

  /// Asks for the whole list on the next step, even when it has not changed.
  void resync() => _etag = '';

  /// Fetches the list and the projects again now (pull to refresh); done when the answer or an error is in.
  Future<void> refresh() {
    resync();
    _projectsAt = DateTime.fromMillisecondsSinceEpoch(0);
    _ask();
    final done = Completer<void>();
    void settled() {
      if (pending && error == null) return;
      removeListener(settled);
      if (!done.isCompleted) done.complete();
    }
    addListener(settled);
    return done.future.timeout(const Duration(seconds: 15), onTimeout: () => removeListener(settled));
  }

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
  /// Turns the feed follows (the latest ones), and the size of a page of earlier ones.
  static const window = 10;
  String _etag = '';
  final Map<String, Turn> _turns = {};
  /// The followed turns, oldest first.
  List<String> _order = [];
  /// Earlier turns already fetched, oldest first; they are finished and no longer change.
  List<Turn> _older = [];
  List<FollowUp> followUps = [];
  bool loaded = false;
  /// Turns before the oldest one held here.
  int earlier = 0;
  bool loadingEarlier = false;

  List<Turn> get turns => [..._older, for (final id in _order) if (_turns[id] != null) _turns[id]!];
  Turn? get activeTurn => _order.map((id) => _turns[id]).where((turn) => turn != null && turn.active).firstOrNull;

  @override
  Future<void> step() async {
    final changes = await client.turnChanges(conversationId, _etag, wait: loaded ? wait : Duration.zero, last: window);
    if (changes.unchanged) return;
    final first = changes.order.firstOrNull;
    if (_order.contains(first)) {
      // New turns pushed the oldest followed ones out: they stay, as earlier turns.
      final left = _order.takeWhile((id) => id != first).map((id) => _turns[id]).whereType<Turn>().toList();
      _older = [..._older, ...left];
    } else {
      // Nothing in common with what is held (first answer, or a long time away): start from the latest again.
      _older = [];
      earlier = changes.earlier;
    }
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

  /// Fetches the page of turns before the oldest one held (when the user scrolls up to it).
  Future<void> loadEarlier() async {
    final oldest = _older.firstOrNull?.id ?? _order.firstOrNull;
    if (loadingEarlier || earlier == 0 || oldest == null) return;
    loadingEarlier = true;
    try {
      final more = await client.earlierTurns(conversationId, oldest, limit: window);
      // The feed may have started over meanwhile: only add to the list this page continues.
      if ((_older.firstOrNull?.id ?? _order.firstOrNull) != oldest) return;
      _older = [...more.turns, ..._older];
      earlier = more.earlier;
    } finally {
      loadingEarlier = false;
      notifyListeners();
    }
  }

  /// Asks for everything again on the next step (after sending, so the new turn shows at once).
  void poke() {
    stop();
    start();
  }
}
