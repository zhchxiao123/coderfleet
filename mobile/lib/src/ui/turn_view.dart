// One turn of a conversation: the user's message (and attachments), the answer
// as Markdown interleaved with tool calls (an Agent's own steps under it),
// approvals and questions, status, and time/copy/translate/fork once finished.
import 'dart:convert';

// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../backend.dart';
import '../models.dart';
import 'streaming_answer.dart';
import 'theme.dart';

/// Fetches project uploads once per path for the conversation view.
class UploadCache {
  UploadCache(this.client, this.projectId);
  final BackendClient client;
  final String projectId;
  final Map<String, Future<Uint8List>> _cache = {};
  Future<Uint8List> load(String path) => _cache.putIfAbsent(path, () => client.image(projectId, path).then(Uint8List.fromList));
  void seed(String path, Uint8List bytes) => _cache[path] = Future.value(bytes);
}

class TurnView extends StatefulWidget {
  const TurnView({super.key, required this.turn, required this.client, required this.images, required this.onChanged, this.canTranslate = false, this.onFork});
  final Turn turn;
  final BackendClient client;
  final UploadCache images;
  final VoidCallback onChanged;
  final bool canTranslate;
  /// Opens the conversation a fork created.
  final void Function(Conversation created)? onFork;
  @override
  State<TurnView> createState() => _TurnViewState();
}

class _TurnViewState extends State<TurnView> {
  /// Translated text per answer block (by its text), and whether the translation is showing.
  final Map<String, String> translations = {};
  bool showing = false, forking = false;
  ({int done, int total})? progress;
  String? translateFailure;

  Turn get turn => widget.turn;
  List<String> get texts => [for (final block in turn.blocks) if (block is TextBlock && block.text.trim().isNotEmpty) block.text];

  Future<void> _translate() async {
    if (showing) { setState(() => showing = false); return; }
    final missing = texts.where((text) => !translations.containsKey(text)).toList();
    if (missing.isEmpty) { setState(() => showing = true); return; }
    setState(() { progress = (done: texts.length - missing.length, total: texts.length); translateFailure = null; });
    try {
      await Future.wait(missing.map((text) async {
        final translated = await widget.client.translate(text);
        translations[text] = translated;
        if (mounted) setState(() => progress = (done: progress!.done + 1, total: progress!.total));
      }));
      if (mounted) setState(() { showing = true; progress = null; });
    } on BackendError catch (error) {
      if (mounted) setState(() { progress = null; translateFailure = translateError(error.message); });
    }
  }

  Future<void> _fork() async {
    setState(() => forking = true);
    try {
      final created = await widget.client.fork(turn.conversationId, turn.id);
      if (!mounted) return;
      showMessage(context, '已从这里分叉：新对话接着这轮回答继续，项目文件是共享的');
      widget.onFork?.call(created);
    } on BackendError catch (error) {
      if (mounted) showMessage(context, error.message);
    } finally {
      if (mounted) setState(() => forking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final children = <Widget>[UserMessage(text: turn.prompt, images: turn.images, cache: widget.images)];
    final group = <Tool>[];
    void flush() {
      if (group.isEmpty) return;
      children.add(ToolGroup(tools: [...group], turn: turn, client: widget.client));
      group.clear();
    }

    if (progress != null || translateFailure != null) children.add(_translationStatus(palette));
    for (final (index, block) in turn.blocks.indexed) {
      switch (block) {
        case ToolBlock(:final id):
          final tool = turn.tool(id);
          if (tool != null && tool.parent.isEmpty) group.add(tool);
        case TextBlock(:final text):
          flush();
          if (text.trim().isNotEmpty) {
            // The block being written is the last one of a turn that still runs.
            children.add(StreamingAnswer(key: ValueKey('answer-$index'), text: showing ? translations[text] ?? text : text,
                live: turn.active && index == turn.blocks.length - 1));
          }
        case UserBlock(:final text, images: final paths):
          flush();
          children.add(UserMessage(text: text, images: paths, cache: widget.images, label: '插话'));
      }
    }
    flush();
    final permission = turn.permission;
    if (permission != null && turn.active) {
      children.add(permission.questions != null
          ? QuestionCard(turn: turn, permission: permission, client: widget.client, onDone: widget.onChanged)
          : ApprovalCard(turn: turn, permission: permission, client: widget.client, onDone: widget.onChanged));
    }
    if (turn.active && permission == null) children.add(RunningStatus(stopping: turn.stopping));
    if (turn.status == 'cancelled') children.add(_Note(icon: Icons.stop_circle_outlined, text: '已中断', color: palette.text3));
    if (turn.status == 'queued') children.add(_Note(icon: Icons.schedule, text: '在原服务里排队，还没有运行', color: palette.text3));
    if (turn.status == 'failed') {
      children.add(Container(
        margin: const EdgeInsets.only(top: 8), padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: palette.red.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(12)),
        child: Text(turn.error.isEmpty ? '执行失败' : turn.error, style: TextStyle(color: palette.red, fontSize: 13.5)),
      ));
    }
    if (!turn.active && turn.status != 'queued') children.add(_actions(palette));
    return Opacity(
      opacity: turn.inherited ? 0.6 : 1,
      child: Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 18), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children)),
    );
  }

  Widget _translationStatus(Palette palette) {
    final failure = translateFailure;
    final style = TextStyle(color: failure != null ? palette.red : palette.text3, fontSize: 12.5);
    return Padding(padding: const EdgeInsets.only(bottom: 8), child: Row(children: [
      if (failure == null) SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.5, color: palette.text3))
      else Icon(Icons.error_outline, size: 14, color: palette.red),
      const SizedBox(width: 7),
      Expanded(child: Text(failure == null
          ? '正在翻译成中文…${progress!.total > 1 ? ' ${progress!.done}/${progress!.total} 段' : ''}'
          : '翻译失败：$failure', style: style)),
      if (failure != null) GestureDetector(onTap: _translate, child: Text('重试', style: style.copyWith(color: palette.accent, fontWeight: FontWeight.w600))),
    ]));
  }

  /// Time and actions under a finished answer: copy, translate, fork (Claude).
  Widget _actions(Palette palette) {
    final text = texts.join('\n\n');
    final time = turn.finishedAt ?? turn.createdAt;
    Widget action(IconData icon, String label, VoidCallback? onTap, {bool on = false}) => IconButton(
          icon: Icon(icon, size: 17, color: on ? palette.accent : palette.text3), tooltip: label, onPressed: onTap,
          visualDensity: VisualDensity.compact, constraints: const BoxConstraints(minWidth: 34, minHeight: 34), padding: EdgeInsets.zero);
    return Padding(padding: const EdgeInsets.only(top: 2), child: Row(children: [
      if (time != null) Padding(padding: const EdgeInsets.only(right: 4), child: Text(shortTime(time), style: TextStyle(color: palette.text3, fontSize: 12))),
      if (text.isNotEmpty) action(Icons.copy_rounded, '复制', () async {
        await Clipboard.setData(ClipboardData(text: showing ? texts.map((item) => translations[item] ?? item).join('\n\n') : text));
        if (mounted) showMessage(context, '已复制');
      }),
      if (text.isNotEmpty && widget.canTranslate) action(Icons.translate, showing ? '显示原文' : '翻译成中文', progress == null ? _translate : null, on: showing),
      if (turn.forkable && widget.onFork != null) action(Icons.call_split, '从这里分叉', forking ? null : _fork),
    ]));
  }
}

/// A translation failure in plain words; the provider's text only when nothing better fits.
String translateError(String raw) {
  final status = int.tryParse(RegExp(r'上游返回 (\d{3})').firstMatch(raw)?.group(1) ?? '') ?? 0;
  if (status == 401 || status == 403) return 'API Key 无效或没有权限，请在电脑上检查 设置 → 翻译与命名';
  if (status == 404) return '找不到这个模型或接口地址，请在电脑上检查 设置 → 翻译与命名';
  if (status == 429) return '模型的调用次数或额度用完了，稍后再试';
  if (status >= 500) return '模型服务暂时出错（$status），稍后再试';
  if (raw.contains('超时')) return '连接模型超时，检查网络或出站代理';
  return raw.length > 160 ? '${raw.substring(0, 160)}…' : raw;
}

/// Today: 14:05; this year: 11月3日 14:05; older: 2025年11月3日.
String shortTime(DateTime time, {DateTime? now}) {
  final local = time.toLocal(), today = (now ?? DateTime.now()).toLocal();
  String two(int value) => value.toString().padLeft(2, '0');
  final clock = '${two(local.hour)}:${two(local.minute)}';
  if (local.year == today.year && local.month == today.month && local.day == today.day) return clock;
  if (local.year == today.year) return '${local.month}月${local.day}日 $clock';
  return '${local.year}年${local.month}月${local.day}日';
}

/// A non-image attachment: an icon with the extension, the name and the size.
class FileChip extends StatelessWidget {
  const FileChip({super.key, required this.name, this.size, this.height = 52, this.maxWidth = 240});
  final String name;
  final int? size;
  final double height, maxWidth;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final extension = RegExp(r'\.([A-Za-z0-9]{1,6})$').firstMatch(name)?.group(1)?.toUpperCase() ?? '';
    return Container(
      height: height, constraints: BoxConstraints(maxWidth: maxWidth), padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: palette.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 30, height: 34, alignment: Alignment.center,
            decoration: BoxDecoration(color: palette.accent.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(6)),
            child: Text(extension.isEmpty ? '文件' : extension, maxLines: 1, style: TextStyle(color: palette.accent, fontSize: 9.5, fontWeight: FontWeight.w700))),
        const SizedBox(width: 8),
        Flexible(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text, fontSize: 13, fontWeight: FontWeight.w500)),
          if (size != null) Text(humanSize(size!), style: TextStyle(color: palette.text3, fontSize: 11.5)),
        ])),
      ]),
    );
  }
}

String humanSize(int size) => size < 1024 ? '$size B' : size < 1048576 ? '${(size / 1024).toStringAsFixed(size < 10240 ? 1 : 0)} KB' : '${(size / 1048576).toStringAsFixed(1)} MB';

class UserMessage extends StatelessWidget {
  const UserMessage({super.key, required this.text, required this.images, required this.cache, this.label});
  final String text;
  final List<String> images;
  final UploadCache cache;
  final String? label;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final width = MediaQuery.of(context).size.width * 0.8;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
        if (label != null) Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(label!, style: TextStyle(color: palette.text3, fontSize: 11.5))),
        if (images.isNotEmpty)
          Padding(padding: const EdgeInsets.only(bottom: 6), child: Wrap(alignment: WrapAlignment.end, spacing: 6, runSpacing: 6, children: [
            for (final path in images)
              isImageUpload(path) ? Thumb(path: path, cache: cache, size: images.where(isImageUpload).length == 1 ? 180 : 96) : FileChip(name: uploadName(path)),
          ])),
        if (text.isNotEmpty)
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: width),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              decoration: BoxDecoration(color: palette.fill, borderRadius: BorderRadius.circular(18)),
              child: SelectableText(text, style: TextStyle(fontSize: 15.5, height: 1.5, color: palette.text)),
            ),
          ),
      ]),
    );
  }
}

class Thumb extends StatelessWidget {
  const Thumb({super.key, required this.path, required this.cache, this.size = 96});
  final String path;
  final UploadCache cache;
  final double size;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return FutureBuilder<Uint8List>(
      future: cache.load(path),
      builder: (context, snapshot) => GestureDetector(
        onTap: snapshot.hasData ? () => Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => Scaffold(
              backgroundColor: Colors.black, appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white),
              body: Center(child: InteractiveViewer(child: Image.memory(snapshot.data!)))))) : null,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: Container(
            width: size, height: size, color: palette.fill,
            child: snapshot.hasData
                ? Image.memory(snapshot.data!, fit: BoxFit.cover, gaplessPlayback: true)
                : Icon(snapshot.hasError ? Icons.broken_image_outlined : Icons.image_outlined, color: palette.text3),
          ),
        ),
      ),
    );
  }
}

class Answer extends StatelessWidget {
  const Answer({super.key, required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final base = TextStyle(fontSize: 15.5, height: 1.65, color: palette.text);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: MarkdownBody(
        data: text, selectable: true,
        styleSheet: MarkdownStyleSheet(
          p: base, listBullet: base, a: base.copyWith(color: palette.accent),
          h1: base.copyWith(fontSize: 21, fontWeight: FontWeight.w700), h2: base.copyWith(fontSize: 18.5, fontWeight: FontWeight.w700),
          h3: base.copyWith(fontSize: 16.5, fontWeight: FontWeight.w600),
          code: mono.copyWith(color: palette.text, backgroundColor: palette.fill),
          codeblockDecoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(12)),
          codeblockPadding: const EdgeInsets.all(12),
          blockquoteDecoration: BoxDecoration(border: Border(left: BorderSide(color: palette.line, width: 3))),
          blockquotePadding: const EdgeInsets.only(left: 12),
          blockquote: base.copyWith(color: palette.text2),
          tableBorder: TableBorder.all(color: palette.line), tableHead: base.copyWith(fontWeight: FontWeight.w600),
          tableBody: base.copyWith(fontSize: 14), tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        ),
        // Links open in the phone's browser; anything that is not a web address stays inert.
        onTapLink: (_, href, _) {
          final uri = Uri.tryParse(href ?? '');
          if (uri != null && (uri.isScheme('http') || uri.isScheme('https'))) launchUrl(uri, mode: LaunchMode.externalApplication).ignore();
        },
        builders: {'pre': _CodeBlock(palette)},
      ),
    );
  }
}

/// Code blocks scroll sideways inside their own box, in light text on a dark background.
class _CodeBlock extends MarkdownElementBuilder {
  _CodeBlock(this.palette);
  final Palette palette;
  @override
  bool isBlockElement() => true;

  @override
  Widget? visitText(text, preferredStyle) => Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(12)),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Text(text.text.replaceAll(RegExp(r'\n$'), ''), style: mono.copyWith(color: const Color(0xFFE3E7EF), backgroundColor: Colors.transparent)),
        ),
      );
}

const _toolLabels = {
  ToolStatus.running: '运行中', ToolStatus.waiting: '等你确认', ToolStatus.completed: '完成', ToolStatus.failed: '失败',
  ToolStatus.denied: '已拒绝', ToolStatus.interrupted: '已中断', ToolStatus.unknown: '没有返回结果',
};

/// Tool calls as one-line rows; a finished group of more than three folds into a summary row.
class ToolGroup extends StatefulWidget {
  const ToolGroup({super.key, required this.tools, required this.turn, required this.client});
  final List<Tool> tools;
  final Turn turn;
  final BackendClient client;
  @override
  State<ToolGroup> createState() => _ToolGroupState();
}

class _ToolGroupState extends State<ToolGroup> {
  bool open = false;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final tools = widget.tools;
    final settled = tools.every((tool) => tool.settled);
    if (!settled || tools.length <= 3 || open) {
      return Padding(padding: const EdgeInsets.only(bottom: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (settled && tools.length > 3) _summary(palette),
        for (final tool in tools) ToolRow(tool: tool, turn: widget.turn, client: widget.client),
      ]));
    }
    return Padding(padding: const EdgeInsets.only(bottom: 8), child: _summary(palette));
  }

  Widget _summary(Palette palette) {
    final failed = widget.tools.where((tool) => tool.status == ToolStatus.failed).length;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => setState(() => open = !open),
      child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [
        ToolGlyph(status: failed > 0 ? ToolStatus.failed : ToolStatus.completed),
        const SizedBox(width: 8),
        Text('使用了 ${widget.tools.length} 个工具', style: TextStyle(color: palette.text2, fontWeight: FontWeight.w500)),
        if (failed > 0) Padding(padding: const EdgeInsets.only(left: 6), child: _Pill(text: '$failed 个失败', color: palette.red)),
        Icon(open ? Icons.expand_less : Icons.expand_more, size: 18, color: palette.text3),
      ])),
    );
  }
}

class ToolGlyph extends StatelessWidget {
  const ToolGlyph({super.key, required this.status});
  final ToolStatus status;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return SizedBox(width: 16, height: 16, child: switch (status) {
      ToolStatus.running => Padding(padding: const EdgeInsets.all(2), child: CircularProgressIndicator(strokeWidth: 1.6, color: palette.accent)),
      ToolStatus.waiting => Center(child: Container(width: 8, height: 8, decoration: BoxDecoration(color: palette.amber, shape: BoxShape.circle))),
      ToolStatus.completed => Icon(Icons.check, size: 15, color: palette.green),
      ToolStatus.failed => Container(decoration: BoxDecoration(color: palette.red, shape: BoxShape.circle), child: const Icon(Icons.close, size: 11, color: Colors.white)),
      ToolStatus.denied => Icon(Icons.block, size: 14, color: palette.text3),
      ToolStatus.interrupted => Icon(Icons.stop, size: 14, color: palette.text3),
      ToolStatus.unknown => Icon(Icons.remove, size: 14, color: palette.text3),
    });
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.color});
  final String text;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(6)),
        child: Text(text, style: TextStyle(color: color, fontSize: 11.5, fontWeight: FontWeight.w600)),
      );
}

class ToolRow extends StatefulWidget {
  const ToolRow({super.key, required this.tool, required this.turn, required this.client});
  final Tool tool;
  final Turn turn;
  final BackendClient client;
  @override
  State<ToolRow> createState() => _ToolRowState();
}

class _ToolRowState extends State<ToolRow> {
  bool unfolded = false;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final tool = widget.tool;
    final struck = tool.status == ToolStatus.denied || tool.status == ToolStatus.interrupted;
    final pillColor = switch (tool.status) {
      ToolStatus.running => palette.accent,
      ToolStatus.waiting => palette.amber,
      ToolStatus.failed => palette.red,
      _ => palette.text3,
    };
    final row = InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (_) => ToolSheet(tool: tool, turn: widget.turn, client: widget.client)),
      child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [
        ToolGlyph(status: tool.status),
        const SizedBox(width: 8),
        Text(tool.title, style: TextStyle(color: struck ? palette.text3 : palette.text2, fontWeight: FontWeight.w500, decoration: struck ? TextDecoration.lineThrough : null)),
        const SizedBox(width: 8),
        Expanded(child: Text(tool.detail.replaceFirst(RegExp(r'^/workspace/'), ''), maxLines: 1, overflow: TextOverflow.ellipsis, style: mono.copyWith(color: palette.text3, fontSize: 12))),
        if (tool.status != ToolStatus.completed) Padding(padding: const EdgeInsets.only(left: 6), child: _Pill(text: _toolLabels[tool.status]!, color: pillColor)),
      ])),
    );
    // An Agent call's own steps, indented under it: the latest few while it runs, folded once it is done.
    final children = widget.turn.children(tool.id);
    if (children.isEmpty) return row;
    final running = !tool.settled;
    final failed = children.where((item) => item.status == ToolStatus.failed).length;
    final shown = unfolded ? children : running ? children.sublist(children.length > 5 ? children.length - 5 : 0) : <Tool>[];
    final label = unfolded ? '收起子步骤'
        : running ? (children.length > shown.length ? '前面还有 ${children.length - shown.length} 步' : '')
            : '${children.length} 个子步骤${failed > 0 ? ' · $failed 个失败' : ''}';
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      row,
      Container(
        margin: const EdgeInsets.only(left: 7), padding: const EdgeInsets.only(left: 12),
        decoration: BoxDecoration(border: Border(left: BorderSide(color: palette.line, width: 1.5))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (label.isNotEmpty) InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => setState(() => unfolded = !unfolded),
            child: Padding(padding: const EdgeInsets.symmetric(vertical: 5), child: Row(children: [
              Text(label, style: TextStyle(color: palette.text3, fontSize: 13)),
              Icon(unfolded ? Icons.expand_less : Icons.expand_more, size: 16, color: palette.text3),
            ])),
          ),
          for (final item in shown) ToolRow(key: ValueKey(item.id), tool: item, turn: widget.turn, client: widget.client),
        ]),
      ),
    ]);
  }
}

/// A tool call's input and output, fetched when opened.
class ToolSheet extends StatelessWidget {
  const ToolSheet({super.key, required this.tool, required this.turn, required this.client});
  final Tool tool;
  final Turn turn;
  final BackendClient client;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return DraggableScrollableSheet(
      expand: false, initialChildSize: 0.6, maxChildSize: 0.92,
      builder: (context, scroll) => FutureBuilder<ToolDetail>(
        future: client.toolDetail(turn.id, tool.id),
        builder: (context, snapshot) {
          final detail = snapshot.data;
          final empty = switch (tool.status) {
            ToolStatus.running => '还在运行，结束后显示输出。',
            ToolStatus.waiting => '等你确认后才会运行。',
            ToolStatus.denied => '已拒绝，没有运行。',
            _ => '没有输出。',
          };
          return ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(20, 0, 20, 32), children: [
            Row(children: [ToolGlyph(status: tool.status), const SizedBox(width: 8), Text(tool.title, style: Theme.of(context).textTheme.titleMedium)]),
            const SizedBox(height: 16),
            if (snapshot.hasError) Text('读取失败：${snapshot.error}', style: TextStyle(color: palette.red)),
            if (detail == null && !snapshot.hasError) const Center(child: CircularProgressIndicator.adaptive()),
            if (detail != null) ...[
              if (detail.input.isNotEmpty) ...[_label(palette, '输入'), InputView(input: detail.input), const SizedBox(height: 18)],
              _label(palette, tool.status == ToolStatus.failed ? '错误' : '输出'),
              // Images the tool returned (e.g. Read of a picture); tapping opens one full size.
              for (final data in detail.images) Padding(padding: const EdgeInsets.only(bottom: 8), child: _ToolImage(bytes: base64Decode(data))),
              if (detail.output.isEmpty && detail.images.isEmpty) Text(empty, style: TextStyle(color: palette.text3)),
              if (detail.output.isNotEmpty) _Box(child: SelectableText(detail.output, style: mono.copyWith(color: tool.status == ToolStatus.failed ? palette.red : palette.text2))),
            ],
          ]);
        },
      ),
    );
  }

  Widget _label(Palette palette, String text) =>
      Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(text, style: TextStyle(color: palette.text3, fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 0.5)));
}

class _ToolImage extends StatelessWidget {
  const _ToolImage({required this.bytes});
  final Uint8List bytes;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: () => Navigator.of(context).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => Scaffold(
              backgroundColor: Colors.black, appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white),
              body: Center(child: InteractiveViewer(child: Image.memory(bytes)))))),
        child: Align(alignment: Alignment.centerLeft, child: ClipRRect(borderRadius: BorderRadius.circular(10),
            child: ConstrainedBox(constraints: const BoxConstraints(maxHeight: 260), child: Image.memory(bytes, fit: BoxFit.contain)))),
      );
}

class _Box extends StatelessWidget {
  const _Box({required this.child, this.dark = false});
  final Widget child;
  final bool dark;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Container(
      width: double.infinity, padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: dark ? palette.code : palette.fill, borderRadius: BorderRadius.circular(10)),
      child: child,
    );
  }
}

/// A tool input the way a person checks it: the command, the edit as a diff, the file written, or JSON.
class InputView extends StatelessWidget {
  const InputView({super.key, required this.input});
  final Map<String, dynamic> input;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final raw = input['rawInput'] is Map ? (input['rawInput'] as Map).cast<String, dynamic>() : input;
    final file = [raw['file_path'], raw['filePath'], raw['path'], raw['notebook_path']].whereType<String>().firstOrNull;
    final command = raw['command'] is List ? (raw['command'] as List).join(' ') : (raw['command'] ?? raw['cmd']);
    final children = <Widget>[];
    if (file != null) {
      children.add(Padding(padding: const EdgeInsets.only(bottom: 6), child: Row(children: [
        Icon(Icons.description_outlined, size: 14, color: palette.text3), const SizedBox(width: 6),
        Expanded(child: Text(file.replaceFirst(RegExp(r'^/workspace/'), ''), style: mono.copyWith(color: palette.text2))),
      ])));
    }
    if (command is String && command.isNotEmpty) {
      children.add(_Box(dark: true, child: SelectableText('\$ $command', style: mono.copyWith(color: const Color(0xFFE3E7EF)))));
    } else if (raw['old_string'] is String || raw['new_string'] is String) {
      children.add(Diff(removed: raw['old_string'] as String? ?? '', added: raw['new_string'] as String? ?? ''));
    } else if (raw['content'] is String && file != null) {
      children.add(Diff(removed: '', added: raw['content'] as String));
    } else {
      final rest = Map.of(raw)..removeWhere((key, _) => file != null && ['file_path', 'filePath', 'path', 'notebook_path'].contains(key));
      if (rest.isNotEmpty) children.add(_Box(child: SelectableText(const JsonEncoder.withIndent('  ').convert(rest), style: mono.copyWith(color: palette.text2))));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
  }
}

class Diff extends StatelessWidget {
  const Diff({super.key, required this.removed, required this.added, this.maxLines});
  final String removed, added;
  final int? maxLines;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    List<Widget> lines(String text, String sign, Color color) {
      if (text.isEmpty) return const [];
      var all = text.split('\n');
      if (maxLines != null && all.length > maxLines!) {
        all = [...all.take(maxLines!), '…'];
      }
      return [for (final line in all) Container(
        width: double.infinity, color: color.withValues(alpha: 0.1), padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 1),
        child: Text('$sign $line', style: mono.copyWith(color: color)),
      )];
    }
    return ClipRRect(borderRadius: BorderRadius.circular(10), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      ...lines(removed, '−', palette.red), ...lines(added, '+', palette.green),
    ]));
  }
}

class ApprovalCard extends StatefulWidget {
  const ApprovalCard({super.key, required this.turn, required this.permission, required this.client, required this.onDone});
  final Turn turn;
  final Permission permission;
  final BackendClient client;
  final VoidCallback onDone;
  @override
  State<ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends State<ApprovalCard> {
  bool busy = false;
  Future<void> _decide(bool allow) async {
    setState(() => busy = true);
    try {
      await widget.client.decide(widget.turn.id, widget.permission.id, allow: allow);
      widget.onDone();
    } on BackendError catch (error) {
      if (mounted) showMessage(context, error.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    Map<String, dynamic> input = {};
    try { input = (jsonDecode(widget.permission.details) as Map).cast<String, dynamic>(); } catch (_) {}
    return _Card(
      icon: Icons.shield_outlined, title: widget.permission.title, subtitle: '需要你确认这一步操作',
      body: input.isEmpty ? null : InputView(input: input),
      actions: [
        OutlinedButton(onPressed: busy ? null : () => _decide(false), child: const Text('拒绝')),
        FilledButton.icon(onPressed: busy || !widget.permission.allow ? null : () => _decide(true), icon: const Icon(Icons.check, size: 18), label: const Text('允许')),
      ],
      palette: palette,
    );
  }
}

class QuestionCard extends StatefulWidget {
  const QuestionCard({super.key, required this.turn, required this.permission, required this.client, required this.onDone});
  final Turn turn;
  final Permission permission;
  final BackendClient client;
  final VoidCallback onDone;
  @override
  State<QuestionCard> createState() => _QuestionCardState();
}

class _QuestionCardState extends State<QuestionCard> {
  final Map<String, Set<String>> picked = {};
  final Map<String, TextEditingController> other = {};
  bool busy = false;

  Map<String, String> get answers {
    final result = <String, String>{};
    for (final question in widget.permission.questions!) {
      final values = [...?picked[question.question], if ((other[question.question]?.text.trim() ?? '').isNotEmpty) other[question.question]!.text.trim()];
      if (values.isNotEmpty) result[question.question] = values.join(', ');
    }
    return result;
  }

  Future<void> _submit() async {
    setState(() => busy = true);
    try {
      await widget.client.answer(widget.turn.id, widget.permission.id, answers);
      widget.onDone();
    } on BackendError catch (error) {
      if (mounted) showMessage(context, error.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final questions = widget.permission.questions!;
    return _Card(
      icon: Icons.help_outline, title: '需要你回答', subtitle: '回答后会继续执行', palette: palette,
      body: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final question in questions) ...[
          Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(question.question, style: TextStyle(color: palette.text, fontWeight: FontWeight.w500))),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final option in question.options)
              ChoiceChip(
                label: Text(option.label), tooltip: option.description.isEmpty ? null : option.description,
                selected: picked[question.question]?.contains(option.label) ?? false,
                onSelected: (selected) => setState(() {
                  final set = picked.putIfAbsent(question.question, () => {});
                  if (!question.multiSelect) set.clear();
                  if (selected) { set.add(option.label); } else { set.remove(option.label); }
                }),
              ),
          ]),
          Padding(padding: const EdgeInsets.only(top: 8, bottom: 14), child: TextField(
            controller: other.putIfAbsent(question.question, TextEditingController.new),
            decoration: const InputDecoration(hintText: '其他回答（可选）'), onChanged: (_) => setState(() {}),
          )),
        ],
      ]),
      actions: [FilledButton(onPressed: busy || answers.length != questions.length ? null : _submit, child: const Text('提交回答'))],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.icon, required this.title, required this.subtitle, required this.actions, required this.palette, this.body});
  final IconData icon;
  final String title, subtitle;
  final Widget? body;
  final List<Widget> actions;
  final Palette palette;
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(top: 6, bottom: 8),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(16),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.06), blurRadius: 18, offset: const Offset(0, 4))]),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Container(width: 32, height: 32, decoration: BoxDecoration(color: palette.accent.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(9)),
                child: Icon(icon, size: 18, color: palette.accent)),
            const SizedBox(width: 10),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: TextStyle(fontWeight: FontWeight.w600, color: palette.text)),
              Text(subtitle, style: TextStyle(color: palette.text3, fontSize: 12.5)),
            ])),
          ]),
          if (body != null) Padding(padding: const EdgeInsets.only(top: 12), child: body),
          const SizedBox(height: 12),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [for (final action in actions) Padding(padding: const EdgeInsets.only(left: 8), child: action)]),
        ]),
      );
}

class RunningStatus extends StatelessWidget {
  const RunningStatus({super.key, this.stopping = false});
  final bool stopping;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Padding(padding: const EdgeInsets.only(top: 4), child: Row(children: [
      SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: palette.accent)),
      const SizedBox(width: 8),
      Text(stopping ? '正在停止…' : '正在处理', style: TextStyle(color: palette.accent, fontWeight: FontWeight.w500)),
    ]));
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.icon, required this.text, required this.color});
  final IconData icon;
  final String text;
  final Color color;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.only(top: 6), child: Row(children: [
        Icon(icon, size: 14, color: color), const SizedBox(width: 6), Text(text, style: TextStyle(color: color, fontSize: 13)),
      ]));
}
