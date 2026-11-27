// 领航's page: the thread, its cards answered with the words the backend takes, the user's words, taking back, and opening conversations.
import 'dart:convert';
import 'dart:typed_data';

import 'package:coderfleet_mobile/src/backend.dart';
import 'package:coderfleet_mobile/src/state.dart';
import 'package:coderfleet_mobile/src/ui/attachments.dart';
import 'package:coderfleet_mobile/src/ui/lead_screen.dart';
import 'package:coderfleet_mobile/src/ui/theme.dart';
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
    await tester.tap(find.descendant(of: find.byKey(const ValueKey('d1')), matching: find.text('依据')));
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

  testWidgets('files in the thread: the user\'s show with their words, an image opens, what 领航 handed over is listed', (tester) async {
    final (backend, _) = await openLead(tester);
    final message = find.byKey(const ValueKey('u2'));
    expect(find.descendant(of: message, matching: find.text('按这张图改登录页')), findsOneWidget);
    expect(find.descendant(of: message, matching: find.text('设计说明.pdf')), findsOneWidget);
    // The picture comes from 领航's uploads, not a project's.
    expect(backend.queries.any((url) => Uri.decodeComponent(url.path) == '/v1/lead/uploads/00000000000aa1b2-登录页.png'), isTrue);
    await tester.tap(find.descendant(of: message, matching: find.byType(Image)));
    await settle(tester, 3);
    expect(find.byType(InteractiveViewer), findsOneWidget);
    await tester.tap(find.byType(CloseButton));
    await settle(tester, 3);

    final did = find.byKey(const ValueKey('d2'));
    await tester.tap(find.descendant(of: did, matching: find.text('依据')));
    await settle(tester, 2);
    expect(find.descendant(of: did, matching: find.text('一起交过去的附件')), findsOneWidget);
    expect(find.descendant(of: did, matching: find.text('设计说明.pdf')), findsOneWidget);
    expect(find.descendant(of: did, matching: find.byType(Image)), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('files picked in the box are uploaded to 领航 and go with the words', (tester) async {
    await loadFonts();
    tester.view.physicalSize = const Size(1000, 3200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final backend = FakeBackend()..seedLead();
    final client = BackendClient(Profile(id: 'p1', name: '本机', token: backend.token, addresses: [profile.address]), client: backend.client);
    final feed = ConversationFeed(client);
    final png = base64Decode(tinyPng);
    Future<List<PickedFile>> source(BuildContext context, AttachFrom from) async => from == AttachFrom.photos
        ? [pickedBytes('截图.png', Uint8List.fromList(png))]
        : [pickedBytes('日志.txt', Uint8List.fromList(utf8.encode('error: 401')))];
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light, fontFamily: 'Roboto', fontFamilyFallback: const ['NotoCJK']),
        home: LeadScreen(client: client, feed: feed, wait: const Duration(milliseconds: 300), attachmentSource: source)));
    await settle(tester);

    for (final from in ['从相册选择', '选择文件']) {
      await tester.tap(find.byTooltip('添加附件'));
      await settle(tester, 2);
      await tester.tap(find.text(from));
      await settle(tester, 3);
    }
    final uploads = backend.requests.where((item) => item['path'] == 'lead/uploads').toList();
    expect(uploads.map((item) => item['name']), ['截图.png', '日志.txt']);
    expect(uploads.last['bytes'], utf8.encode('error: 401'));
    expect(backend.requests.where((item) => item['path'].toString().startsWith('projects/')), isEmpty);
    // Files alone can be sent; here with words.
    await tester.enterText(find.widgetWithText(TextField, '直接说就行：交代一件事，或者一句话回它问你的几件事…'), '看看这个报错');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await settle(tester);
    final said = backend.requests.lastWhere((item) => item['path'] == 'lead/messages')['body'] as Map;
    expect(said['text'], '看看这个报错');
    expect((said['attachments'] as List).map((path) => '$path'.replaceFirst(RegExp(r'^/lead/uploads/[0-9a-f]{16}-'), '')), ['截图.png', '日志.txt']);
    // In the thread, the message shows its files; the box is empty again.
    expect(find.text('看看这个报错'), findsOneWidget);
    expect(find.text('日志.txt'), findsOneWidget);
    expect(find.byTooltip('发送'), findsOneWidget);

    // A hint says only its words, never the files waiting in the box.
    await tester.tap(find.byTooltip('添加附件'));
    await settle(tester, 2);
    await tester.tap(find.text('选择文件'));
    await settle(tester, 3);
    await tester.tap(find.text('你现在能自己定什么'));
    await settle(tester);
    expect(backend.requests.lastWhere((item) => item['path'] == 'lead/messages')['body'], {'text': '你现在能自己定什么'});
    feed.dispose();
    await teardown(tester);
  });
}
