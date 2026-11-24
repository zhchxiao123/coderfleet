// Renders the main screens at iPhone size into $SHOTS (default /tmp/cf-mobile-shots).
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_backend.dart';
import 'test_app.dart';

final out = Platform.environment['SHOTS'] ?? '/tmp/cf-mobile-shots';

Future<List<int>> samplePng() async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(const Rect.fromLTWH(0, 0, 320, 200), Paint()..color = const Color(0xFF5A78E6));
  canvas.drawCircle(const Offset(220, 80), 40, Paint()..color = const Color(0xFFFFD166));
  final image = await recorder.endRecording().toImage(320, 200);
  return (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
}

void main() {
  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    final name = mode.name;
    testWidgets('screens ($name)', (tester) async {
      tester.view.physicalSize = const Size(1179, 2556);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final backend = FakeBackend()..seedDemo();
      await pumpApp(tester, backend, signedIn: false, mode: mode);
      await screenshot(tester, '$out/$name-1-connect.png');
      await teardown(tester);

      await pumpApp(tester, backend, mode: mode);
      await screenshot(tester, '$out/$name-2-list.png');
      await tester.tap(find.text('请帮我梳理一下服务启动流程'));
      await settle(tester);
      await screenshot(tester, '$out/$name-3-chat-approval.png');
      await tester.drag(find.byType(ListView).last, const Offset(0, 900));
      await settle(tester, 2);
      await screenshot(tester, '$out/$name-4-chat-markdown.png');
      await tester.tap(find.text('listen'));
      await settle(tester, 4);
      await screenshot(tester, '$out/$name-5-tool.png');
      await tester.tapAt(const Offset(200, 80));
      await settle(tester, 2);
      await tester.pageBack();
      await settle(tester, 2);

      await tester.tap(find.text('新对话'));
      await settle(tester, 3);
      await screenshot(tester, '$out/$name-6-project-picker.png');
      await tester.tap(find.text('coderfleet').last);
      await settle(tester, 3);
      final bytes = await tester.runAsync(samplePng);
      final path = await tester.runAsync(() => backend.client.post(Uri.parse('http://192.168.1.20:8877/v1/projects/coderfleet/uploads'),
          headers: {'Authorization': 'Bearer cfd_test'}, body: '{"name":"a.png","data":"${base64Encode(bytes!)}"}'));
      expect(path!.statusCode, 200);
      await tester.enterText(find.byType(TextField), '看看这张截图里的按钮为什么错位');
      await tester.pump();
      await screenshot(tester, '$out/$name-7-composer.png');
      await teardown(tester);
    });
  }
}
