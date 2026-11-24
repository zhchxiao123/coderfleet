// One conversation: turns (newest at the bottom), queued messages, and the
// composer with images, auto mode, model, send and stop. Sending while a turn
// runs goes into it (Claude) or waits as the next turn (other agents).
import 'dart:async';
import 'dart:typed_data';

// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:image_picker/image_picker.dart';

import '../backend.dart';
import '../models.dart';
import '../state.dart';
import 'theme.dart';
import 'turn_view.dart';

/// Per-project auto mode, remembered on the phone.
class AutoModeStore {
  AutoModeStore({this.persist = true});
  final bool persist;
  static const _storage = FlutterSecureStorage();
  final Map<String, bool> _memory = {};
  Future<bool> get(String key) async {
    if (_memory.containsKey(key) || !persist) return _memory[key] ?? false;
    try { return _memory[key] = await _storage.read(key: 'auto:$key') == '1'; } catch (_) { return false; }
  }
  Future<void> set(String key, bool value) async {
    _memory[key] = value;
    if (persist) { try { await _storage.write(key: 'auto:$key', value: value ? '1' : ''); } catch (_) {} }
  }
}

/// Picks images; tests replace it.
typedef ImageSource2 = Future<List<({String name, Uint8List bytes})>> Function(BuildContext context, {required bool camera});

Future<List<({String name, Uint8List bytes})>> pickImages(BuildContext context, {required bool camera}) async {
  final picker = ImagePicker();
  final files = camera
      ? [?await picker.pickImage(source: ImageSource.camera, maxWidth: 2048, maxHeight: 2048, imageQuality: 85)]
      : await picker.pickMultiImage(maxWidth: 2048, maxHeight: 2048, imageQuality: 85, limit: 10);
  return [for (final file in files) (name: file.name, bytes: await file.readAsBytes())];
}

class _Attachment {
  _Attachment(this.name, this.bytes);
  final String name;
  final Uint8List bytes;
  String? path;
}

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key, required this.client, required this.feed, required this.projectId, this.conversation,
    this.autoStore, this.imageSource = pickImages, this.chatWait = const Duration(seconds: 25),
  });
  final BackendClient client;
  final ConversationFeed feed;
  final Conversation? conversation;
  final String projectId;
  final AutoModeStore? autoStore;
  final ImageSource2 imageSource;
  final Duration chatWait;
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> with WidgetsBindingObserver {
  late final AutoModeStore autos = widget.autoStore ?? AutoModeStore();
  late final UploadCache images = UploadCache(widget.client, widget.projectId);
  final input = TextEditingController();
  final attachments = <_Attachment>[];
  ChatFeed? chat;
  String? conversationId;
  String title = '新对话';
  bool auto = false, sending = false;
  List<ModelOption> models = [];
  String model = '';

  String get autoKey => '${widget.client.profile.id}:${widget.projectId}';
  Project? get project => widget.feed.project(widget.projectId);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    conversationId = widget.conversation?.id;
    title = widget.conversation?.name ?? '新对话';
    if (conversationId != null) _follow(conversationId!);
    input.addListener(() => setState(() {}));
    autos.get(autoKey).then((value) { if (mounted) setState(() => auto = value); });
    widget.client.models(widget.projectId).then((list) { if (mounted) setState(() => models = list); }).catchError((_) {});
  }

  void _follow(String id) {
    chat?.dispose();
    chat = ChatFeed(widget.client, id, wait: widget.chatWait)..start();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      chat?.start();
    } else if (state == AppLifecycleState.paused) {
      chat?.stop();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    chat?.dispose();
    input.dispose();
    super.dispose();
  }

  Future<void> _addImages({required bool camera}) async {
    List<({String name, Uint8List bytes})> picked;
    try { picked = await widget.imageSource(context, camera: camera); } catch (error) { if (mounted) showMessage(context, '没能读取图片：$error'); return; }
    for (final file in picked.take(20 - attachments.length)) {
      final item = _Attachment(file.name, file.bytes);
      setState(() => attachments.add(item));
      widget.client.upload(widget.projectId, file.name.contains('.') ? file.name : '${file.name}.jpg', file.bytes).then((path) {
        images.seed(path, file.bytes);
        if (mounted) setState(() => item.path = path);
      }).catchError((Object error) {
        if (!mounted) return;
        setState(() => attachments.remove(item));
        showMessage(context, '图片上传失败：$error');
      });
    }
  }

  Future<void> _send() async {
    final text = input.text.trim();
    if (sending || (text.isEmpty && attachments.isEmpty) || attachments.any((item) => item.path == null)) return;
    setState(() => sending = true);
    try {
      var id = conversationId;
      if (id == null) {
        final created = await widget.client.createConversation(widget.projectId);
        id = conversationId = created.id;
        _follow(id);
      }
      final delivery = await widget.client.send(id, prompt: text, images: [for (final item in attachments) item.path!], model: model, auto: auto);
      input.clear();
      setState(() => attachments.clear());
      if (conversationId == widget.conversation?.id || title == '新对话') title = text.isEmpty ? '图片' : text.replaceAll(RegExp(r'\s+'), ' ');
      if (delivery == Delivery.queued && mounted) showMessage(context, '已排队，这一轮结束后自动发出');
      chat?.poke();
    } on BackendError catch (error) {
      if (mounted) showMessage(context, error.message);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Future<void> _stop() async {
    final turn = chat?.activeTurn;
    if (turn == null) return;
    try { await widget.client.cancel(turn.id); chat?.poke(); } on BackendError catch (error) { if (mounted) showMessage(context, error.message); }
  }

  Future<void> _rename() async {
    final id = conversationId;
    if (id == null) return;
    final controller = TextEditingController(text: title);
    final name = await showDialog<String>(context: context, builder: (context) => AlertDialog(
      title: const Text('重命名对话'),
      content: TextField(controller: controller, autofocus: true, maxLength: 100),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('保存')),
      ],
    ));
    if (name == null || name.isEmpty) return;
    try { await widget.client.rename(id, name); setState(() => title = name); } on BackendError catch (error) { if (mounted) showMessage(context, error.message); }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final feed = chat;
    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
          Text(project == null ? widget.projectId : '${project!.name} · ${project!.typeLabel}', style: TextStyle(fontSize: 12, color: palette.text3, fontWeight: FontWeight.w400)),
        ]),
        actions: [if (conversationId != null) IconButton(icon: const Icon(Icons.edit_outlined), tooltip: '重命名', onPressed: _rename)],
      ),
      body: Column(children: [
        Expanded(child: feed == null
            ? _Welcome(project: project, projectId: widget.projectId)
            : ListenableBuilder(listenable: feed, builder: (context, _) {
                if (!feed.loaded) {
                  return Center(child: feed.error == null ? const CircularProgressIndicator.adaptive() : Text(feed.error!, style: TextStyle(color: palette.text3)));
                }
                final turns = feed.turns.reversed.toList();
                return Column(children: [
                  if (feed.error != null)
                    Container(width: double.infinity, color: palette.amber.withValues(alpha: 0.12), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                        child: Text('连接中断，正在重连…', style: TextStyle(color: palette.amber, fontSize: 13))),
                  Expanded(child: ListView.builder(
                    reverse: true, keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag, padding: const EdgeInsets.only(top: 8),
                    itemCount: turns.length,
                    itemBuilder: (context, index) => TurnView(key: ValueKey(turns[index].id), turn: turns[index], client: widget.client, images: images, onChanged: () => feed.poke()),
                  )),
                ]);
              })),
        if (feed != null) ListenableBuilder(listenable: feed, builder: (context, _) => _composer(palette, feed.activeTurn, feed.followUps)) else _composer(palette, null, const []),
      ]),
    );
  }

  Widget _composer(Palette palette, Turn? running, List<FollowUp> followUps) {
    final ready = project?.running ?? true;
    final uploading = attachments.any((item) => item.path == null);
    final canSend = !sending && ready && !uploading && (input.text.trim().isNotEmpty || attachments.isNotEmpty);
    return SafeArea(top: false, child: Padding(padding: const EdgeInsets.fromLTRB(10, 4, 10, 8), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (!ready)
        Container(margin: const EdgeInsets.only(bottom: 8), padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: palette.amber.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
            child: Text('项目容器没有运行，在电脑上启动后才能对话。', style: TextStyle(color: palette.amber, fontSize: 13))),
      for (final item in followUps)
        Container(
          margin: const EdgeInsets.only(bottom: 6), padding: const EdgeInsets.fromLTRB(10, 2, 2, 2),
          decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(10), border: Border.all(color: palette.line)),
          child: Row(children: [
            Text('排队中', style: TextStyle(color: palette.text3, fontSize: 12, fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Expanded(child: Text(item.text.isEmpty ? '图片' : item.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text2, fontSize: 13.5))),
            IconButton(icon: const Icon(Icons.close, size: 16), tooltip: '不发了', onPressed: () async {
              try { await widget.client.withdraw(conversationId!, item.id); chat?.poke(); } on BackendError catch (error) { if (mounted) showMessage(context, error.message); }
            }),
          ]),
        ),
      Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(22),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.07), blurRadius: 20, offset: const Offset(0, 4))]),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (attachments.isNotEmpty)
            SizedBox(height: 68, child: ListView(scrollDirection: Axis.horizontal, children: [
              for (final item in attachments)
                Padding(padding: const EdgeInsets.only(right: 8, bottom: 8), child: Stack(children: [
                  ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.memory(item.bytes, width: 60, height: 60, fit: BoxFit.cover,
                      opacity: AlwaysStoppedAnimation(item.path == null ? 0.45 : 1))),
                  if (item.path == null) const Positioned.fill(child: Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)))),
                  Positioned(top: 2, right: 2, child: GestureDetector(
                    onTap: () => setState(() => attachments.remove(item)),
                    child: Container(width: 20, height: 20, decoration: const BoxDecoration(color: Color(0xB80F1115), shape: BoxShape.circle),
                        child: const Icon(Icons.close, size: 12, color: Colors.white)),
                  )),
                ])),
            ])),
          TextField(
            controller: input, minLines: 1, maxLines: 6, textInputAction: TextInputAction.newline,
            decoration: InputDecoration(
              hintText: running == null ? '给 ${project?.name ?? widget.projectId} 发消息' : (running.takesMessages ? '插话：会进入当前这一轮' : '排队：这一轮结束后发出'),
              border: InputBorder.none, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none, filled: false, contentPadding: const EdgeInsets.symmetric(vertical: 6),
            ),
          ),
          Row(children: [
            _iconButton(palette, Icons.add_photo_alternate_outlined, '添加图片', () => showModalBottomSheet<void>(context: context, builder: (sheet) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
              ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('拍照'), onTap: () { Navigator.pop(sheet); _addImages(camera: true); }),
              ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('从相册选择'), onTap: () { Navigator.pop(sheet); _addImages(camera: false); }),
            ])))),
            const SizedBox(width: 4),
            _chip(palette, Icons.bolt, '自动', auto, () async {
              final next = !auto;
              if (next) {
                final ok = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
                  title: const Text('打开自动模式？'),
                  content: const Text('之后发的消息里，工具直接执行，不再逐个确认（Claude 跳过权限确认，Codex 不再限制在工作区，其他账号自动批准）。'),
                  actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('打开'))],
                ));
                if (ok != true) return;
              }
              setState(() => auto = next);
              await autos.set(autoKey, next);
            }),
            if (models.isNotEmpty) ...[
              const SizedBox(width: 6),
              PopupMenuButton<String>(
                initialValue: model, onSelected: (value) => setState(() => model = value), enabled: running == null,
                itemBuilder: (_) => [const PopupMenuItem(value: '', child: Text('默认模型')), for (final item in models) PopupMenuItem(value: item.id, child: Text(item.label))],
                child: _chipBody(palette, Icons.tune, model.isEmpty ? '默认模型' : (models.where((item) => item.id == model).firstOrNull?.label ?? model), false),
              ),
            ],
            const Spacer(),
            if (running != null) Padding(padding: const EdgeInsets.only(right: 6), child: _round(palette, Icons.stop_rounded, '中断', _stop, filled: false)),
            _round(palette, Icons.arrow_upward_rounded, '发送', canSend ? _send : null),
          ]),
        ]),
      ),
    ])));
  }

  Widget _iconButton(Palette palette, IconData icon, String tooltip, VoidCallback onTap) =>
      IconButton(icon: Icon(icon, color: palette.text2), tooltip: tooltip, onPressed: onTap, visualDensity: VisualDensity.compact);

  Widget _chipBody(Palette palette, IconData icon, String label, bool on) => Container(
        height: 30, padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(color: on ? palette.amber.withValues(alpha: 0.14) : palette.fill, borderRadius: BorderRadius.circular(15)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 15, color: on ? palette.amber : palette.text3), const SizedBox(width: 3),
          Text(label, style: TextStyle(fontSize: 13, color: on ? palette.amber : palette.text2, fontWeight: FontWeight.w500)),
        ]),
      );

  Widget _chip(Palette palette, IconData icon, String label, bool on, VoidCallback onTap) =>
      Semantics(button: true, toggled: on, label: label, child: GestureDetector(onTap: onTap, child: _chipBody(palette, icon, label, on)));

  Widget _round(Palette palette, IconData icon, String tooltip, VoidCallback? onTap, {bool filled = true}) => Tooltip(
        message: tooltip,
        child: Material(
          color: filled ? (onTap == null ? palette.fill : palette.ink) : palette.surface,
          shape: CircleBorder(side: filled ? BorderSide.none : BorderSide(color: palette.line)),
          child: InkWell(customBorder: const CircleBorder(), onTap: onTap, child: SizedBox(width: 36, height: 36,
              child: Icon(icon, size: 20, color: filled ? (onTap == null ? palette.text3 : palette.inkText) : palette.text))),
        ),
      );
}

class _Welcome extends StatelessWidget {
  const _Welcome({required this.project, required this.projectId});
  final Project? project;
  final String projectId;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Center(child: Padding(padding: const EdgeInsets.all(32), child: Column(mainAxisSize: MainAxisSize.min, children: [
      Container(width: 52, height: 52, decoration: BoxDecoration(color: palette.ink, borderRadius: BorderRadius.circular(15)), alignment: Alignment.center,
          child: Text('C', style: TextStyle(color: palette.inkText, fontSize: 24, fontWeight: FontWeight.w700))),
      const SizedBox(height: 16),
      Text('在 ${project?.name ?? projectId} 里做点什么？', textAlign: TextAlign.center, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: palette.text)),
      const SizedBox(height: 6),
      Text('对话在项目容器里运行，可以读写这个项目的文件。', textAlign: TextAlign.center, style: TextStyle(color: palette.text2)),
    ])));
  }
}
