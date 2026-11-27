// The list and a conversation hold only what is on screen and fetch the rest while scrolling.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';
import 'test_app.dart';

List<String> _asked(FakeBackend backend, String path) =>
    [for (final item in backend.queries) if (item.path == '/v1/$path') item.query];

void main() {
  testWidgets('the list shows the latest page, more at its end, and searches on the backend', (tester) async {
    final backend = FakeBackend();
    final now = DateTime.now();
    // 第 1 条 is the newest, 第 70 条 the oldest.
    for (var index = 70; index >= 1; index--) {
      backend.conversation(index == 66 ? 'reminis-app' : 'coderfleet', '第 $index 条', updatedAt: now.subtract(Duration(minutes: index)));
    }
    await pumpApp(tester, backend);
    expect(_asked(backend, 'conversations/changes').first, contains('limit=30'));
    expect(find.text('第 1 条'), findsOneWidget);

    Future<void> toEnd() async {
      await tester.drag(find.byType(ListView), const Offset(0, -20000));
      await settle(tester);
    }
    await toEnd();
    // The end of the first page asked for the second one.
    expect(find.text('第 31 条', skipOffstage: false), findsOneWidget);
    expect(_asked(backend, 'conversations/changes').last, contains('limit=60'));
    await toEnd();
    await toEnd();
    expect(find.text('第 70 条'), findsOneWidget);
    await toEnd();
    // Everything is here: nothing more is asked for.
    expect(_asked(backend, 'conversations/changes').where((query) => query.contains('limit=120')), isEmpty);

    await tester.tap(find.byIcon(Icons.search));
    await settle(tester, 2);
    await tester.enterText(find.byType(TextField), 'Reminis');
    await settle(tester);
    // Found by its project, though it was far down the list.
    expect(find.text('第 66 条'), findsOneWidget);
    expect(find.text('第 1 条'), findsNothing);
    expect(_asked(backend, 'conversations/changes').last, allOf(contains('q=reminis'), contains('limit=30')));

    await tester.tap(find.byIcon(Icons.close));
    await settle(tester);
    expect(find.text('第 1 条'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('a conversation opens on its latest turns and fetches earlier ones when scrolled up', (tester) async {
    final backend = FakeBackend();
    final chat = backend.conversation('coderfleet', '长对话')['id'] as String;
    for (var index = 1; index <= 25; index++) {
      backend.addTurn(chat, {'prompt': '问题 $index', 'answer': '回答 $index', 'blocks': [{'kind': 'text', 'text': '回答 $index'}]});
    }
    await pumpApp(tester, backend);
    await tester.tap(find.text('长对话'));
    await settle(tester);
    expect(_asked(backend, 'conversations/$chat/changes').first, contains('last=10'));
    expect(find.text('回答 25'), findsOneWidget);
    expect(_asked(backend, 'conversations/$chat/turns'), isEmpty);

    Future<void> toTop() async {
      await tester.drag(find.byType(ListView), const Offset(0, 20000));
      await settle(tester);
    }
    await toTop();
    expect(_asked(backend, 'conversations/$chat/turns'), hasLength(1));
    await toTop();
    await toTop();
    expect(find.text('问题 1'), findsOneWidget);
    await toTop();
    // 15 earlier turns came in two pages; at the first turn nothing more is fetched.
    expect(_asked(backend, 'conversations/$chat/turns'), hasLength(2));

    // A new turn while far up: the earlier ones stay.
    await tester.runAsync(() async => backend.addTurn(chat, {'prompt': '问题 26', 'answer': '回答 26', 'blocks': [{'kind': 'text', 'text': '回答 26'}]}));
    await settle(tester);
    expect(find.text('问题 1'), findsOneWidget);
    await tester.drag(find.byType(ListView), const Offset(0, -40000));
    await settle(tester);
    expect(find.text('回答 26'), findsOneWidget);
    await teardown(tester);
  });

  testWidgets('a conversation shorter than the screen starts at the top', (tester) async {
    final backend = FakeBackend();
    final chat = backend.conversation('coderfleet', '短对话')['id'] as String;
    backend.addTurn(chat, {'prompt': '只有一句', 'answer': '好的', 'blocks': [{'kind': 'text', 'text': '好的'}]});
    await pumpApp(tester, backend);
    await tester.tap(find.text('短对话'));
    await settle(tester);
    final height = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    expect(tester.getTopLeft(find.text('只有一句')).dy, lessThan(height / 3));
    await teardown(tester);
  });

  testWidgets('scrolled up, the text on screen stays put while the answer below is written; at the end the view follows', (tester) async {
    final backend = FakeBackend();
    final chat = backend.conversation('coderfleet', '在写')['id'] as String;
    for (var index = 1; index <= 6; index++) {
      backend.addTurn(chat, {'prompt': '问题 $index', 'answer': '回答 $index', 'blocks': [{'kind': 'text', 'text': '回答 $index\n\n第二段\n\n第三段'}]});
    }
    final running = backend.addTurn(chat, {'prompt': '写长一点', 'status': 'running', 'controlReady': true, 'capabilities': ['interrupt'], 'blocks': [{'kind': 'text', 'text': '开头'}]});
    backend.pending[running['id'] as String] = 100000;
    Future<void> write(int paragraphs) async {
      running['blocks'] = [{'kind': 'text', 'text': ['开头', for (var index = 1; index <= paragraphs; index++) '新写的第 $index 段'].join('\n\n')}];
      backend.changed();
      await settle(tester);
      // The text is written out at its pace.
      for (var frame = 0; frame < 80; frame += 1) { await tester.pump(const Duration(milliseconds: 50)); }
    }
    await pumpApp(tester, backend);
    await tester.tap(find.text('在写'));
    await settle(tester);
    expect(find.byTooltip('回到底部').hitTestable(), findsNothing);

    // At the end: what is written comes into view.
    await write(3);
    expect(find.text('新写的第 3 段', findRichText: true).hitTestable(), findsOneWidget);

    await tester.drag(find.byType(ListView), const Offset(0, 400));
    await settle(tester, 2);
    final before = tester.getTopLeft(find.text('问题 6')).dy;
    await write(9);
    expect(tester.getTopLeft(find.text('问题 6')).dy, closeTo(before, 0.5));
    expect(find.text('新写的第 9 段', findRichText: true).hitTestable(), findsNothing);

    await tester.tap(find.byTooltip('回到底部'));
    await settle(tester, 3);
    expect(find.text('新写的第 9 段', findRichText: true).hitTestable(), findsOneWidget);
    expect(find.byTooltip('回到底部').hitTestable(), findsNothing);
    await teardown(tester);
  });
}
