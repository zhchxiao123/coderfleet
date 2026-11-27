// What the desktop chat gained and the phone now has too: any file as an
// attachment, one send/stop button, an Agent's steps under it, images in tool
// output, and time/copy/translate/fork under a finished answer.
import 'dart:convert';
import 'dart:typed_data';

import 'package:coderfleet_mobile/src/backend.dart';
import 'package:coderfleet_mobile/src/state.dart';
import 'package:coderfleet_mobile/src/ui/chat_screen.dart';
import 'package:coderfleet_mobile/src/ui/theme.dart';
import 'package:coderfleet_mobile/src/ui/turn_view.dart';
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';
import 'test_app.dart';

Future<void> openChat(WidgetTester tester, String name) async {
  await tester.tap(find.text(name));
  await settle(tester);
}

void main() {
  testWidgets('any file can be attached; it is sent and shown as a file chip', (tester) async {
    await loadFonts();
    final backend = FakeBackend()..seedDemo();
    final client = BackendClient(Profile(id: 'p1', name: '本机', token: backend.token, addresses: [profile.address]), client: backend.client);
    final feed = ConversationFeed(client);
    await tester.runAsync(feed.refreshProjects);
    Future<List<PickedFile>> source(BuildContext context, AttachFrom from) async =>
        [pickedBytes('需求说明.pdf', Uint8List.fromList(utf8.encode('%PDF-1.4 demo')))];
    await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light, fontFamily: 'Roboto', fontFamilyFallback: const ['NotoCJK']),
        home: ChatScreen(client: client, feed: feed, projectId: 'coderfleet', autoStore: AutoModeStore(persist: false), attachmentSource: source, chatWait: const Duration(milliseconds: 300))));
    await settle(tester, 3);
    await tester.tap(find.byTooltip('添加附件'));
    await settle(tester, 2);
    expect(find.text('选择文件'), findsOneWidget);
    await tester.tap(find.text('选择文件'));
    await settle(tester, 3);
    expect(find.text('需求说明.pdf'), findsOneWidget);
    expect(find.text('PDF'), findsOneWidget);
    await tester.tap(find.byTooltip('发送'));
    await settle(tester, 3);
    final upload = backend.requests.firstWhere((item) => item['path'] == 'projects/coderfleet/uploads');
    expect(upload['name'], '需求说明.pdf');
    expect(upload['bytes'], utf8.encode('%PDF-1.4 demo'));
    final sent = backend.requests.firstWhere((item) => item['method'] == 'POST' && item['path'].toString().endsWith('/turns'));
    expect((sent['body']['images'] as List).single, endsWith('-需求说明.pdf'));
    // In the conversation the file shows as a chip, not a broken image.
    expect(find.text('需求说明.pdf'), findsOneWidget);
    expect(find.byIcon(Icons.broken_image_outlined), findsNothing);
    feed.dispose();
    await teardown(tester);
  });

  testWidgets('one button: stop while a turn runs with nothing typed, send once something is', (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    await openChat(tester, '请帮我梳理一下服务启动流程');
    expect(find.byTooltip('中断'), findsOneWidget);
    expect(find.byTooltip('发送'), findsNothing);
    await tester.enterText(find.byType(TextField).last, '顺便看看端口');
    await tester.pump();
    expect(find.byTooltip('中断'), findsNothing);
    expect(find.byTooltip('发送'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, '');
    await tester.pump();
    await tester.tap(find.byTooltip('中断'));
    await settle(tester, 3);
    expect(backend.requests.where((item) => item['path'].toString().endsWith('/cancel')), hasLength(1));
    await teardown(tester);
  });

  testWidgets("an Agent's own steps fold under it; a tool's images show in its output", (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    await openChat(tester, '请帮我梳理一下服务启动流程');
    await tester.drag(find.byType(ListView).last, const Offset(0, 900));
    await settle(tester, 2);
    expect(find.text('2 个子步骤'), findsOneWidget);
    expect(find.text('src/conf.ts'), findsNothing);
    await tester.tap(find.text('2 个子步骤'));
    await settle(tester, 2);
    expect(find.text('src/conf.ts'), findsOneWidget);
    expect(find.text('收起子步骤'), findsOneWidget);
    // The user's attachment is a file chip.
    expect(find.text('启动日志.txt'), findsOneWidget);

    await tester.tap(find.text('docs/arch.png'));
    await settle(tester, 4);
    expect(find.byType(Image), findsWidgets);
    expect(find.text('没有输出。'), findsNothing);
    await teardown(tester);
  });

  testWidgets('a finished answer has its time, copy, translate and fork', (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    await openChat(tester, '请帮我梳理一下服务启动流程');
    await tester.drag(find.byType(ListView).last, const Offset(0, 900));
    await settle(tester, 2);
    expect(find.byTooltip('复制'), findsOneWidget);
    await tester.ensureVisible(find.byTooltip('翻译成中文'));
    await tester.pump();
    await tester.tap(find.byTooltip('翻译成中文'));
    await settle(tester, 3);
    expect(find.textContaining('译：', findRichText: true), findsOneWidget);
    await tester.tap(find.byTooltip('显示原文'));
    await settle(tester, 2);
    expect(find.textContaining('译：', findRichText: true), findsNothing);

    await tester.ensureVisible(find.byTooltip('从这里分叉'));
    await tester.pump();
    await tester.tap(find.byTooltip('从这里分叉'));
    await settle(tester, 4);
    expect(backend.requests.where((item) => item['path'].toString().endsWith('/fork')).single['body'], {'turnId': backend.turns.values.first.first['id']});
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('请帮我梳理一下服务启动流程（分叉）')), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('without a translation model there is no translate button', (tester) async {
    final backend = FakeBackend()..seedDemo()..translation = false;
    await pumpApp(tester, backend);
    await openChat(tester, '修一下登录页的样式');
    expect(find.byTooltip('复制'), findsOneWidget);
    expect(find.byTooltip('翻译成中文'), findsNothing);
    // Codex: no fork.
    expect(find.byTooltip('从这里分叉'), findsNothing);
    await teardown(tester);
  });

  testWidgets('a conversation keeps the model its last message used', (tester) async {
    final backend = FakeBackend()..seedDemo();
    final conversation = backend.conversation('coderfleet', '换模型');
    backend.addTurn(conversation['id'] as String, {'prompt': 'first', 'requestedModel': 'sonnet', 'answer': 'ok', 'blocks': [{'kind': 'text', 'text': 'ok'}]});
    await pumpApp(tester, backend);
    await openChat(tester, '换模型');
    expect(find.text('Sonnet'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, 'second');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await settle(tester, 3);
    expect(backend.requests.lastWhere((item) => item['path'].toString().endsWith('/turns'))['body']['model'], 'sonnet');
    await teardown(tester);
  });

  testWidgets('a file the answer sends shows as a card with a download button that saves it', (tester) async {
    final backend = FakeBackend()..seedDemo();
    final conversation = backend.conversation('coderfleet', '导出报告');
    const answer = '报告好了。\n\n<!-- CF_SEND: /workspace/out/report.pdf -->\n\n标记的写法是 `<!-- CF_SEND: path -->`。';
    final turn = backend.addTurn(conversation['id'] as String, {'prompt': '导出', 'answer': answer, 'blocks': [{'kind': 'text', 'text': answer}]});
    final saved = <(String, List<int>)>[];
    final picker = saveSentFile;
    saveSentFile = (name, bytes) async { saved.add((name, bytes)); return true; };
    addTearDown(() => saveSentFile = picker);
    await pumpApp(tester, backend);
    await openChat(tester, '导出报告');
    expect(find.text('report.pdf'), findsOneWidget);
    expect(find.text('out/report.pdf'), findsOneWidget);
    expect(find.textContaining('CF_SEND: /workspace', findRichText: true), findsNothing);
    await tester.tap(find.byTooltip('下载'));
    await settle(tester, 3);
    expect(backend.queries.singleWhere((url) => url.path.endsWith('turns/${turn['id']}/files')).queryParameters['path'], 'out/report.pdf');
    expect([saved.single.$1, utf8.decode(saved.single.$2)], ['report.pdf', 'file']);
    await teardown(tester);
  });

  test('answer text is cut at file markers; quoted and unfinished ones are not files', () {
    expect(answerParts('plain'), [(text: 'plain', file: '')]);
    expect(answerParts('a\n<!-- CF_SEND: ./x.txt -->\nb `<!-- CF_SEND: y -->`'),
        [(text: 'a\n', file: ''), (text: '', file: 'x.txt'), (text: '\nb `<!-- CF_SEND: y -->`', file: '')]);
    expect(answerParts('<!-- CF_SEND: a.zip -->'), [(text: '', file: 'a.zip')]);
    expect(answerParts('<!--CF_SEND:a.zip-->\ndone <!-- CF_SEND: b', live: true), [(text: '', file: 'a.zip'), (text: '\ndone ', file: '')]);
  });

  test('times: today as a clock, this year with the date, older with the year', () {
    final now = DateTime(2026, 11, 24, 18);
    expect(shortTime(DateTime(2026, 11, 24, 9, 5), now: now), '09:05');
    expect(shortTime(DateTime(2026, 3, 2, 14, 30), now: now), '3月2日 14:30');
    expect(shortTime(DateTime(2025, 12, 31, 8), now: now), '2025年12月31日');
  });
}
