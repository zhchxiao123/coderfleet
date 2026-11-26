import 'dart:async';

import 'package:coderfleet_mobile/src/models.dart';
import 'package:coderfleet_mobile/src/notifications.dart';
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';
import 'test_app.dart';

Conversation item(String id, {String status = 'done', bool attention = false, int turns = 1}) =>
    Conversation(id: id, projectId: 'web', name: 'name $id', status: status, attention: attention, updatedAt: DateTime(2026), turns: turns);

class FakeNotifier implements Notifier {
  final shown = <ConversationEvent>[];
  final _taps = StreamController<String>.broadcast();
  @override
  Stream<String> get taps => _taps.stream;
  @override
  Future<void> init() async {}
  @override
  Future<void> show(ConversationEvent event) async => shown.add(event);
  void tap(String id) => _taps.add(id);
}

Future<void> lifecycle(WidgetTester tester, List<AppLifecycleState> states) async {
  for (final state in states) {
    tester.binding.handleAppLifecycleStateChanged(state);
  }
  await tester.pump();
}

const background = [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused];
const foreground = [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed];

void main() {
  test('a turn that ends or a question that comes up is an event; nothing else is', () {
    final kinds = conversationEvents(
      [item('a', status: 'running'), item('b', status: 'running'), item('c'), item('d', status: 'running'), item('e'), item('f', status: 'running')],
      [item('a'), item('b', status: 'failed'), item('c', turns: 2), item('d', attention: true, status: 'running'), item('e'), item('f', status: 'cancelled'), item('new')],
    ).map((event) => '${event.conversation.id}:${event.kind.name}').toList();
    expect(kinds, ['a:done', 'b:failed', 'c:done', 'd:attention']);
  });

  test('the notification names the project and what happened', () {
    final event = conversationEvents([item('a', status: 'running')], [item('a', status: 'failed')]).single;
    expect((event.title, event.body), ('name a', 'web · 失败了'));
  });

  testWidgets('in the background a finished turn notifies; tapping it opens the conversation', (tester) async {
    final backend = FakeBackend()..seedDemo();
    final notifier = FakeNotifier();
    final target = backend.conversation('coderfleet', '跑一下测试', status: 'running');
    await pumpApp(tester, backend, notifier: notifier);

    // In the foreground nothing is notified.
    backend.addTurn(target['id'] as String, {'prompt': '跑一下测试', 'status': 'running'});
    await settle(tester);
    expect(notifier.shown, isEmpty);

    await lifecycle(tester, background);
    await settle(tester, 3);
    backend.addTurn(target['id'] as String, {'prompt': '再跑一次', 'status': 'done', 'answer': '全部通过', 'blocks': [{'kind': 'text', 'text': '全部通过'}]});
    await settle(tester);
    expect(notifier.shown.map((event) => (event.conversation.id, event.kind)), [(target['id'], ConversationEventKind.done)]);

    await lifecycle(tester, foreground);
    notifier.tap(target['id'] as String);
    await settle(tester);
    expect(find.text('全部通过'), findsOneWidget);

    // A conversation that is gone says so instead of opening another one.
    notifier.tap('missing');
    await settle(tester);
    expect(find.text('这个对话已不存在，或不在当前后端上'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('with a chat open, going to the background still watches every conversation', (tester) async {
    final backend = FakeBackend()..seedDemo();
    final notifier = FakeNotifier();
    final other = backend.conversation('coderfleet', '后台任务', status: 'running');
    await pumpApp(tester, backend, notifier: notifier);
    await tester.tap(find.text('请运行检查并修复'));
    await settle(tester);

    await lifecycle(tester, background);
    await settle(tester, 3);
    backend.addTurn(other['id'] as String, {'prompt': '构建', 'status': 'failed'});
    await settle(tester);
    expect(notifier.shown.map((event) => (event.conversation.id, event.kind)), [(other['id'], ConversationEventKind.failed)]);
    await lifecycle(tester, foreground);
    await teardown(tester);
  });
}
