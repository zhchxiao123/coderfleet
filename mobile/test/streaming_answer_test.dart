import 'package:coderfleet_mobile/src/ui/streaming_answer.dart';
import 'package:coderfleet_mobile/src/ui/theme.dart';
import 'package:coderfleet_mobile/src/ui/turn_view.dart';
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('blocks split at blank lines, but not inside code or between list items', () {
    expect(answerChunks('one\n\ntwo\nthree\n\n```\na\n\nb\n```\n\n1. x\n\n2. y\n\nend'),
        ['one', 'two\nthree', '```\na\n\nb\n```', '1. x\n\n2. y', 'end']);
  });

  test('a half-written end is shown as it will look when finished', () {
    expect(tidyTail('some **bold te'), 'some **bold te**');
    expect(tidyTail('run `npm te'), 'run `npm te`');
    expect(tidyTail('see [the docs](https://exa'), 'see the docs');
    expect(tidyTail('text\n- '), 'text');
    expect(tidyTail('text\n```dart'), 'text');
    expect(tidyTail('text\n```dart\nfinal a'), 'text\n```dart\nfinal a');
    expect(tidyTail('intro\n| a | b |\n| --- |'), 'intro');
    expect(tidyTail('| a | b |\n| --- | --- |\n| 1 | 2'), '| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(tidyTail('done <!-- CF_SE'), 'done ');
  });

  testWidgets('text that arrives in a burst is written out, then is the plain answer', (tester) async {
    Widget app(String text, bool live) => MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: StreamingAnswer(text: text, live: live)));
    String shown() => tester.widgetList<Answer>(find.byType(Answer)).map((answer) => answer.text).join('\n\n');
    const first = 'The first paragraph of the answer, long enough to take a few frames.';
    const whole = '$first\n\nA second paragraph with **bold** text.';

    await tester.pumpWidget(app(first, true));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
    expect(shown().length, inExclusiveRange(0, first.length), reason: 'part of the burst is on screen');
    for (var frame = 0; frame < 60; frame += 1) { await tester.pump(const Duration(milliseconds: 50)); }
    expect(shown(), first);

    await tester.pumpWidget(app(whole, false));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
    expect(shown(), isNot(whole));
    await tester.pumpAndSettle();
    expect(tester.widget<Answer>(find.byType(Answer)).text, whole);

    // An answer that was finished when first seen is simply there.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(app(whole, false));
    expect(tester.widget<Answer>(find.byType(Answer)).text, whole);
  });
}
