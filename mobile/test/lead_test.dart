// 领航's page: the thread, its cards answered with the words the backend takes, the user's words, taking back, and opening conversations.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';
import 'test_app.dart';

/// The app with 领航 seeded, on its page; a tall screen so the whole thread is laid out.
Future<(FakeBackend, Map<String, Map<String, dynamic>>)> openLead(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1000, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final backend = FakeBackend();
  final named = backend.seedLead();
  await pumpApp(tester, backend);
  await tester.tap(find.byTooltip('领航'));
  await settle(tester);
  return (backend, named);
}

List<Map<String, dynamic>> posts(FakeBackend backend, String path) =>
    backend.requests.where((item) => item['method'] == 'POST' && item['path'] == path).toList();

void main() {
  testWidgets('the list opens 领航: the followed conversations by project, then the thread', (tester) async {
    await openLead(tester);
    expect(find.text('在替你跟 7 个对话 · 4 件等你'), findsOneWidget);
    // Read only: whether 领航 runs is shown, and nothing here turns it.
    expect(find.text('在跟'), findsOneWidget);
    expect(find.byType(Switch), findsNothing);

    expect(find.text('正在跟的对话'), findsOneWidget);
    expect(find.text('2 个对话'), findsOneWidget);
    expect(find.text('1 个对话'), findsOneWidget);
    expect(find.text('等你批准'), findsOneWidget);
    expect(find.text('失败了'), findsOneWidget);
    expect(find.text('其余 4 个对话停着，有动静我会接。'), findsOneWidget);

    expect(find.text('现在都在忙什么'), findsWidgets);
    expect(find.textContaining('要做的操作我批了：npm test', findRichText: true), findsOneWidget);
    expect(find.textContaining('做完了，我看过，没有留事情给你', findRichText: true), findsOneWidget);
    expect(find.text('要执行 git push origin main'), findsOneWidget);
    expect(find.text('端口默认用多少？'), findsOneWidget);
    expect(find.text('收下并合并'), findsOneWidget);
    expect(find.text('我倾向 docs/'), findsOneWidget);
    // An answered card says how it closed and has no buttons.
    expect(find.text('你说：拒绝'), findsOneWidget);
    // What 领航 is looking at right now.
    expect(find.text('领航在读对话「修登录页」…'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('cards are answered with the words the backend takes, then the thread refreshes', (tester) async {
    final (backend, _) = await openLead(tester);
    await tester.tap(find.widgetWithText(FilledButton, '批准'));
    await settle(tester);
    expect(posts(backend, 'lead/asks/a1').single['body'], {'answer': '批准'});
    expect(find.text('你说：批准'), findsOneWidget);

    await tester.tap(find.widgetWithText(ChoiceChip, '8877'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '提交回答'));
    await settle(tester);
    expect(posts(backend, 'lead/asks/a2').single['body'], {'answers': {'默认端口': '8877'}});

    await tester.tap(find.widgetWithText(FilledButton, '收下并合并'));
    await settle(tester);
    expect(posts(backend, 'lead/asks/a3').single['body'], {'answer': '收下并合并'});
    expect(find.text('你说：收下并合并'), findsOneWidget);

    // A card that takes any text: the reply goes as written.
    await tester.enterText(find.widgetWithText(TextField, '回复它（原样转给这个对话）'), '写到 docs/lead.md');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '回复'));
    await settle(tester);
    expect(posts(backend, 'lead/asks/a4').single['body'], {'answer': '写到 docs/lead.md'});
    expect(find.text('你说：写到 docs/lead.md'), findsOneWidget);
    expect(find.text('在替你跟 7 个对话 · 没有要你管的'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('按你说的办 tells 领航 so, as a sentence from the user', (tester) async {
    final (backend, _) = await openLead(tester);
    await tester.tap(find.widgetWithText(OutlinedButton, '按你说的办'));
    await settle(tester);
    expect(posts(backend, 'lead/messages').single['body'], {'text': '「补文档」这件按你说的办'});
    await teardown(tester);
  });

  testWidgets('the box and the hints say something to 领航', (tester) async {
    final (backend, _) = await openLead(tester);
    final box = find.widgetWithText(TextField, '直接说就行：交代一件事，或者一句话回它问你的几件事…');
    await tester.enterText(box, '先别合并 reminis');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await settle(tester);
    expect(posts(backend, 'lead/messages').single['body'], {'text': '先别合并 reminis'});
    expect(find.text('先别合并 reminis'), findsOneWidget);
    expect(tester.widget<TextField>(box).controller!.text, isEmpty);

    await tester.tap(find.text('你现在能自己定什么'));
    await settle(tester);
    expect(posts(backend, 'lead/messages').last['body'], {'text': '你现在能自己定什么'});
    await teardown(tester);
  });

  testWidgets('what 领航 settled shows its grounds and can be taken back', (tester) async {
    final (backend, _) = await openLead(tester);
    await tester.tap(find.text('依据'));
    await tester.pump();
    expect(find.text('只是跑测试'), findsOneWidget);
    expect(find.textContaining('git status --short'), findsOneWidget);

    await tester.tap(find.text('撤回'));
    await settle(tester);
    expect(posts(backend, 'lead/undo/d1'), hasLength(1));
    expect(find.text('已撤回'), findsOneWidget);
    expect(find.text('撤回'), findsNothing);
    await teardown(tester);
  });

  testWidgets('a followed conversation, a card and 领航\'s words open their conversation', (tester) async {
    final (backend, named) = await openLead(tester);
    // A row of the list above the thread.
    await tester.tap(find.text('端口读环境变量').first);
    await settle(tester);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('给 coderfleet 发消息'), findsOneWidget);
    expect(backend.queries.any((url) => url.path == '/v1/conversations/${named['port']!['id']}/changes'), isTrue);
    await tester.pageBack();
    await settle(tester);

    // A conversation 领航 names in its words (a conv: link).
    final words = find.descendant(of: find.byKey(const ValueKey('l1')), matching: find.textContaining('修登录页', findRichText: true));
    expect(words, findsOneWidget);
    final before = backend.queries.where((url) => url.path == '/v1/conversations/${named['login']!['id']}/changes').length;
    await tester.tap(words);
    await settle(tester);
    expect(find.text('给 reminis-app 发消息'), findsOneWidget);
    expect(backend.queries.where((url) => url.path == '/v1/conversations/${named['login']!['id']}/changes').length, greaterThan(before));
    await tester.pageBack();
    await settle(tester);

    // The conversation a card is about.
    await tester.tap(find.text('「补文档」'));
    await settle(tester);
    expect(backend.queries.any((url) => url.path == '/v1/conversations/${named['docs']!['id']}/changes'), isTrue);
    await teardown(tester);
  });

  testWidgets('leaving the page stops following 领航', (tester) async {
    final (backend, _) = await openLead(tester);
    await tester.pageBack();
    await settle(tester);
    int polls() => backend.queries.where((url) => url.path == '/v1/lead/changes').length;
    final before = polls();
    await settle(tester, 12);
    expect(polls(), before);
    await teardown(tester);
  });

  testWidgets('a backend from before 领航 says so', (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    await tester.tap(find.byTooltip('领航'));
    await settle(tester);
    expect(find.text('这个后端还没有领航'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('without a system model or switched off, the page says what to do on the computer', (tester) async {
    final backend = FakeBackend()..lead = {'configured': false, 'enabled': false, 'rules': [], 'watching': [], 'rest': 0, 'working': null, 'draft': '', 'step': ''};
    await pumpApp(tester, backend);
    await tester.tap(find.byTooltip('领航'));
    await settle(tester);
    expect(find.text('还没开始'), findsOneWidget);
    expect(find.text('已停'), findsOneWidget);
    expect(find.textContaining('领航要用系统模型来判断', findRichText: true), findsOneWidget);
    expect(find.text('正在跟的对话'), findsNothing);
    backend.lead = {...backend.lead!, 'configured': true};
    backend.changed();
    await settle(tester);
    expect(find.textContaining('领航还没开始', findRichText: true), findsOneWidget);
    await teardown(tester);
  });
}
