// System notifications while the app is in the background: a conversation
// waits for an approval or an answer, finished, or failed. They come from the
// conversation list feed, compared with the list the app had when it left the
// foreground; tapping one opens that conversation.
import 'dart:async';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'models.dart';
import 'state.dart';

enum ConversationEventKind { attention, done, failed }

class ConversationEvent {
  const ConversationEvent(this.kind, this.conversation);
  final ConversationEventKind kind;
  final Conversation conversation;

  String get title => conversation.name;
  String get body => '${conversation.projectId} · ${switch (kind) {
        ConversationEventKind.attention => '等你批准或回答',
        ConversationEventKind.done => '已完成',
        ConversationEventKind.failed => '失败了',
      }}';
}

const _active = {'queued', 'starting', 'running'};

/// What changed between two lists that deserves a notification. Conversations
/// absent from `previous` are skipped: there is nothing to compare them with.
List<ConversationEvent> conversationEvents(List<Conversation> previous, List<Conversation> current) {
  final before = {for (final item in previous) item.id: item};
  final events = <ConversationEvent>[];
  for (final item in current) {
    final old = before[item.id];
    if (old == null) continue;
    if (item.attention && !old.attention) {
      events.add(ConversationEvent(ConversationEventKind.attention, item));
      continue;
    }
    // A turn ended, or a new one started and ended between two answers of the feed.
    final ended = _active.contains(old.status) || item.turns > old.turns;
    if (!ended) continue;
    if (item.status == 'done') events.add(ConversationEvent(ConversationEventKind.done, item));
    if (item.status == 'failed') events.add(ConversationEvent(ConversationEventKind.failed, item));
  }
  return events;
}

abstract class Notifier {
  /// Asks for permission (once per install, by the OS).
  Future<void> init();
  Future<void> show(ConversationEvent event);
  /// Conversation ids of tapped notifications, including the one that launched the app.
  Stream<String> get taps;
}

class LocalNotifier implements Notifier {
  final _plugin = FlutterLocalNotificationsPlugin();
  final _taps = StreamController<String>.broadcast();
  Future<void>? _ready;

  @override
  Stream<String> get taps => _taps.stream;

  @override
  Future<void> init() => _ready ??= _init();

  Future<void> _init() async {
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(),
      ),
      onDidReceiveNotificationResponse: (response) {
        if (response.payload?.isNotEmpty == true) _taps.add(response.payload!);
      },
    );
    await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
    final launch = await _plugin.getNotificationAppLaunchDetails();
    final payload = launch?.notificationResponse?.payload;
    if (launch?.didNotificationLaunchApp == true && payload != null && payload.isNotEmpty) {
      scheduleMicrotask(() => _taps.add(payload));
    }
  }

  @override
  Future<void> show(ConversationEvent event) async {
    await init();
    await _plugin.show(
      // One notification per conversation: a newer state replaces the older one.
      id: event.conversation.id.hashCode & 0x7fffffff,
      title: event.title,
      body: event.body,
      payload: event.conversation.id,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails('conversations', '对话', channelDescription: '对话完成、失败或等你处理', importance: Importance.high, priority: Priority.high),
        iOS: DarwinNotificationDetails(),
      ),
    );
  }
}

/// Watches the conversation feed while the app is in the background.
class BackgroundWatch {
  BackgroundWatch(this.notifier);
  final Notifier notifier;
  List<Conversation>? _baseline;
  ConversationFeed? _feed;

  /// The app left the foreground: what the feed reports from now on is compared with the list the
  /// user last saw. When the feed was paused (a chat was open) its list is stale, so its next answer
  /// becomes the baseline instead.
  void start(ConversationFeed feed, {required bool current}) {
    stop();
    _feed = feed..addListener(_changed);
    _baseline = current && feed.loaded ? feed.conversations : null;
  }

  void stop() {
    _feed?.removeListener(_changed);
    _feed = null;
  }

  void _changed() {
    final current = _feed?.conversations;
    if (current == null) return;
    final previous = _baseline;
    _baseline = current;
    if (previous == null) return;
    for (final event in conversationEvents(previous, current)) {
      unawaited(notifier.show(event).catchError((_) {}));
    }
  }
}
