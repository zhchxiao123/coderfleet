// Adding a backend: scan the desktop App's pairing QR code, paste the pairing
// link, or type an address and device token by hand.
import 'dart:math';

// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../backend.dart';
import '../state.dart';
import 'theme.dart';

String newId() => List.generate(12, (_) => Random.secure().nextInt(16).toRadixString(16)).join();

class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, required this.state, this.canClose = false});
  final AppState state;
  final bool canClose;
  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  bool busy = false;
  String? error;

  Future<void> _use(Profile Function() build) async {
    setState(() { busy = true; error = null; });
    try {
      await widget.state.add(build());
      if (mounted && widget.canClose) Navigator.of(context).pop();
    } on BackendError catch (failure) {
      setState(() => error = failure.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _scan() async {
    final link = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const ScanScreen()));
    if (link != null) await _use(() => parsePairing(link, id: newId()));
  }

  Future<void> _paste() async {
    final clip = (await Clipboard.getData('text/plain'))?.text ?? '';
    if (!mounted) return;
    final controller = TextEditingController(text: clip.startsWith('coderfleet://') ? clip : '');
    final link = await showDialog<String>(context: context, builder: (context) => AlertDialog(
      title: const Text('粘贴配对链接'),
      content: TextField(controller: controller, autofocus: true, maxLines: 3, minLines: 1, decoration: const InputDecoration(hintText: 'coderfleet://pair?…')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text), child: const Text('连接')),
      ],
    ));
    if (link != null && link.trim().isNotEmpty) await _use(() => parsePairing(link, id: newId()));
  }

  Future<void> _manual() async {
    final address = TextEditingController(), token = TextEditingController(), name = TextEditingController(text: 'CoderFleet');
    final result = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (context) => Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('手动填写', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 12),
        TextField(controller: name, decoration: const InputDecoration(labelText: '名称')),
        const SizedBox(height: 10),
        TextField(controller: address, keyboardType: TextInputType.url, autocorrect: false,
            decoration: const InputDecoration(labelText: '地址', hintText: 'https://cf.example.com 或 http://192.168.1.20:8877')),
        const SizedBox(height: 10),
        TextField(controller: token, autocorrect: false, obscureText: true, decoration: const InputDecoration(labelText: '设备令牌', hintText: 'cfd_…')),
        const SizedBox(height: 8),
        Text('设备令牌在电脑上「设置 → 手机访问 → 添加手机」里生成。', style: TextStyle(color: context.palette.text3, fontSize: 12.5)),
        const SizedBox(height: 16),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('连接')),
      ]),
    ));
    if (result != true) return;
    await _use(() {
      if (!token.text.trim().startsWith('cfd_')) throw BackendError('设备令牌以 cfd_ 开头');
      return Profile(id: newId(), name: name.text.trim().isEmpty ? 'CoderFleet' : name.text.trim(), token: token.text.trim(), addresses: [checkAddress(address.text)]);
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Scaffold(
      appBar: widget.canClose ? AppBar(title: const Text('添加后端')) : null,
      body: SafeArea(child: Center(child: SingleChildScrollView(padding: const EdgeInsets.all(28), child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(child: Container(width: 64, height: 64, decoration: BoxDecoration(color: palette.ink, borderRadius: BorderRadius.circular(18)),
              alignment: Alignment.center, child: Text('C', style: TextStyle(color: palette.inkText, fontSize: 30, fontWeight: FontWeight.w700)))),
          const SizedBox(height: 22),
          Text('连接 CoderFleet', textAlign: TextAlign.center, style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: palette.text)),
          const SizedBox(height: 8),
          Text('在电脑上打开「设置 → 手机访问」，点「添加手机」，然后扫二维码。', textAlign: TextAlign.center, style: TextStyle(color: palette.text2, height: 1.5)),
          const SizedBox(height: 28),
          FilledButton.icon(onPressed: busy ? null : _scan, icon: const Icon(Icons.qr_code_scanner), label: const Text('扫码连接')),
          const SizedBox(height: 10),
          OutlinedButton(onPressed: busy ? null : _paste, child: const Text('粘贴配对链接')),
          TextButton(onPressed: busy ? null : _manual, child: Text('手动填写地址和令牌', style: TextStyle(color: palette.text2))),
          if (busy) const Padding(padding: EdgeInsets.only(top: 16), child: Center(child: CircularProgressIndicator.adaptive())),
          if (error != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(error!, textAlign: TextAlign.center, style: TextStyle(color: palette.red))),
        ]),
      )))),
    );
  }
}

/// Full-screen camera that returns the first CoderFleet pairing link it sees.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  bool done = false;
  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white, title: const Text('扫描配对二维码', style: TextStyle(color: Colors.white))),
        body: Stack(children: [
          MobileScanner(onDetect: (capture) {
            final value = capture.barcodes.map((code) => code.rawValue ?? '').firstWhere((value) => value.startsWith('coderfleet://pair'), orElse: () => '');
            if (value.isEmpty || done) return;
            done = true;
            Navigator.of(context).pop(value);
          }),
          Center(child: Container(width: 240, height: 240, decoration: BoxDecoration(border: Border.all(color: Colors.white70, width: 2), borderRadius: BorderRadius.circular(20)))),
        ]),
      );
}
