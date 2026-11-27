// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';
import 'test_app.dart';

void main() {
  testWidgets('without a backend the app asks to pair', (tester) async {
    await pumpApp(tester, FakeBackend(), signedIn: false);
    expect(find.text('连接 CoderFleet'), findsOneWidget);
    expect(find.text('扫码连接'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('conversations list with status, then a turn with tools and an approval', (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    expect(find.text('请帮我梳理一下服务启动流程'), findsOneWidget);
    expect(find.text('修一下登录页的样式'), findsOneWidget);
    // The one waiting for the user leads the list under its own heading; states are written out.
    expect(find.text('等你确认'), findsNWidgets(2));
    expect(find.text('失败'), findsOneWidget);
    expect(find.text('今天'), findsOneWidget);

    await tester.tap(find.text('请帮我梳理一下服务启动流程'));
    await settle(tester);
    expect(find.text('Edit'), findsWidgets);
    expect(find.text('允许'), findsOneWidget);
    expect(find.textContaining('process.env.PORT'), findsOneWidget);

    await tester.tap(find.text('允许'));
    await settle(tester);
    expect(backend.requests.where((item) => item['path'].toString().endsWith('/permission')).single['body'], {'id': 'p1', 'decision': 'allow'});
    expect(find.text('允许'), findsNothing);
    await teardown(tester);
  });

  testWidgets('a tool row opens its input and output', (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    await tester.tap(find.text('请运行检查并修复'));
    await settle(tester);
    await tester.tap(find.text('npm test'));
    await settle(tester, 4);
    expect(find.text('\$ npm test'), findsOneWidget);
    expect(find.textContaining('expected 200, got 401'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('a new conversation: pick a project, send, interject, see the answer', (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    await tester.tap(find.byTooltip('新对话'));
    await settle(tester, 3);
    // Running projects first; the stopped one says so.
    expect(find.text('Antigravity CLI · 容器未运行'), findsOneWidget);
    await tester.tap(find.text('coderfleet').last);
    await settle(tester, 3);
    expect(find.text('在 coderfleet 里做点什么？'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'hello');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await settle(tester, 2);
    expect(find.text('hello'), findsWidgets);
    // While it runs, a Claude turn takes the next message in.
    await tester.enterText(find.byType(TextField), 'also this');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await settle(tester, 2);
    expect(find.text('插话'), findsOneWidget);
    await settle(tester, 10);
    expect(find.text('echo:hello'), findsOneWidget);
    final sent = backend.requests.where((item) => item['method'] == 'POST' && item['path'].toString().endsWith('/turns')).map((item) => item['body']['prompt']).toList();
    expect(sent, ['hello', 'also this']);
    await teardown(tester);
  });

  testWidgets('other agents queue a message sent mid-turn; it can be withdrawn', (tester) async {
    final backend = FakeBackend()..seedDemo();
    final conversation = backend.conversation('reminis-app', 'codex');
    backend.addTurn(conversation['id'] as String, {'prompt': 'slow', 'status': 'running', 'controlReady': true, 'capabilities': ['interrupt']});
    backend.pending[backend.turns[conversation['id']]!.last['id'] as String] = 1000;
    await pumpApp(tester, backend);
    await tester.tap(find.text('codex'));
    await settle(tester);
    expect(find.byTooltip('中断'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'next one');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await settle(tester, 3);
    expect(find.text('排队中'), findsOneWidget);
    await tester.tap(find.byTooltip('不发了'));
    await settle(tester, 3);
    expect(find.text('排队中'), findsNothing);
    await tester.tap(find.byTooltip('中断'));
    await settle(tester, 3);
    expect(find.text('已中断'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('sending in an existing conversation keeps its title', (tester) async {
    final backend = FakeBackend()..seedDemo();
    await pumpApp(tester, backend);
    await tester.tap(find.text('修一下登录页的样式'));
    await settle(tester);
    await tester.enterText(find.byType(TextField), '再改一下按钮颜色');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await settle(tester, 3);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('修一下登录页的样式')), findsOneWidget);
    expect(find.descendant(of: find.byType(AppBar), matching: find.text('再改一下按钮颜色')), findsNothing);
    await teardown(tester);
  });
}
