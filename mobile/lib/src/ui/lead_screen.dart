// 领航: one thread between the user and every conversation it follows (the
// desktop's lead.js). Above it, the followed conversations by project; in it,
// what the user said, 领航's answers, what it settled (one faint line each, some
// can be taken back) and the cards it hands to the user. Its switch stays on
// the computer: the phone shows whether it runs, nothing more.
import 'dart:math';

// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart' hide Thumb;

import '../backend.dart';
import '../models.dart';
import '../state.dart';
import 'attachments.dart';
import 'chat_screen.dart';
import 'theme.dart';
import 'turn_view.dart';

/// Answers a card's server checks by these exact words (node-app/src/lead.ts).
const leadAllow = '批准', leadDeny = '拒绝', leadAccept = '收下并合并', leadRetry = '让它重试', leadMine = '我去看';
const _hints = ['现在都在忙什么', '你现在能自己定什么'];
// Each project keeps one colour on this page, so a line is placed at a glance.
const _colours = [Color(0xFF3B82F6), Color(0xFFA855F7), Color(0xFF14B8A6), Color(0xFFF97316), Color(0xFFEC4899), Color(0xFF84CC16), Color(0xFFEAB308), Color(0xFF64748B)];

String _clip(String text, int size) => text.length > size ? '${text.substring(0, size)}…' : text;

class LeadScreen extends StatefulWidget {
  const LeadScreen({super.key, required this.client, required this.feed, this.wait = const Duration(seconds: 25), this.attachmentSource = pickAttachments});
  final BackendClient client;
  /// The conversation list: a conversation opened from here is looked up in it, and the chat page reads its projects.
  final ConversationFeed feed;
  final Duration wait;
  final AttachmentSource attachmentSource;
  @override
  State<LeadScreen> createState() => _LeadScreenState();
}

class _LeadScreenState extends State<LeadScreen> with WidgetsBindingObserver {
  late final LeadFeed lead = LeadFeed(widget.client, wait: widget.wait)..start();
  final input = TextEditingController();
  final scroller = ScrollController();
  /// 领航's uploads: it belongs to no project, so its files live with it on the backend.
  late final images = UploadCache(widget.client, null);
  late final attachments = Attachments(upload: (name, data, size) => widget.client.upload(null, name, data, size), cache: images)
    ..addListener(() => setState(() {}));
  bool sending = false, folded = false, _chatOpen = false;
  /// The project the page is narrowed to ('' for all).
  String only = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    input.addListener(() => setState(() {}));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && !_chatOpen) {
      lead.start();
    } else if (state == AppLifecycleState.paused) {
      lead.stop();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    lead.dispose();
    input.dispose();
    attachments.dispose();
    scroller.dispose();
    super.dispose();
  }

  List<String> _projects(LeadView view) => {...view.watching.map((item) => item.projectId), ...view.items.map((item) => item.projectId)}.where((id) => id.isNotEmpty).toList()..sort();

  Color _colour(String projectId) {
    final ids = lead.view == null ? const <String>[] : _projects(lead.view!);
    return _colours[max(0, ids.indexOf(projectId)) % _colours.length];
  }

  /// Opens a conversation 领航 names: from the list when it is there, otherwise from what 领航 knows of it.
  void openConversation(String id) {
    final view = lead.view;
    var conversation = widget.feed.conversations.where((item) => item.id == id).firstOrNull;
    if (conversation == null) {
      final watch = view?.watching.where((item) => item.id == id).firstOrNull;
      final named = view?.items.where((item) => item.conversationId == id && item.projectId.isNotEmpty).lastOrNull;
      if (watch != null || named != null) {
        conversation = Conversation(id: id, projectId: watch?.projectId ?? named!.projectId, name: watch?.name ?? named!.conversation,
            status: watch?.status == 'running' ? 'running' : '', attention: watch?.status == 'waiting', updatedAt: watch?.at ?? DateTime.fromMillisecondsSinceEpoch(0),
            turns: 0, account: watch?.account);
      }
    }
    if (conversation == null) {
      showMessage(context, '这个对话已经不在了');
      return;
    }
    lead.stop();
    _chatOpen = true;
    Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => ChatScreen(client: widget.client, feed: widget.feed, conversation: conversation, projectId: conversation!.projectId)))
        .then((_) {
          _chatOpen = false;
          if (mounted) lead.start();
        });
  }

  /// Runs something the user did to 领航, then reads its state again; an error is shown.
  Future<bool> act(Future<void> Function() run) async {
    try {
      await run();
      lead.poke();
      return true;
    } on BackendError catch (error) {
      if (mounted) showMessage(context, error.message);
      return false;
    }
  }

  /// Says [text] to 领航; [typed]: it is what the box holds, sent with the attachments and emptied once sent.
  /// A hint or 按你说的办 says only its words.
  Future<void> say(String text, {bool typed = false}) async {
    final words = text.trim(), files = typed ? attachments.paths : const <String>[];
    if ((words.isEmpty && files.isEmpty) || sending || (typed && attachments.uploading)) return;
    setState(() => sending = true);
    final sent = await act(() => widget.client.leadSay(words, attachments: files));
    if (!mounted) return;
    setState(() => sending = false);
    if (sent && typed) {
      input.clear();
      attachments.clear();
    }
    // What was just said is at the end.
    if (sent && scroller.hasClients) scroller.jumpTo(0);
  }

  void _rules(LeadView view) => showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (sheet) {
        final palette = sheet.palette;
        return SafeArea(child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(sheet).size.height * 0.7),
          child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(20, 0, 20, 16), children: [
            Text('领航的规矩', style: Theme.of(sheet).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text('它只做决定：改代码、提交、合并都是各个对话自己动手。想改规矩，直接跟它说。', style: TextStyle(color: palette.text3, fontSize: 12.5, height: 1.5)),
            const SizedBox(height: 8),
            for (final rule in view.rules)
              Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text.rich(TextSpan(children: [
                TextSpan(text: '· ${rule.text}', style: TextStyle(color: palette.text, height: 1.5)),
                if (rule.fixed) TextSpan(text: '  固定，改不了', style: TextStyle(color: palette.text3, fontSize: 12)),
              ]))),
          ]),
        ));
      });

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return ListenableBuilder(listenable: lead, builder: (context, _) {
      final view = lead.view;
      final followed = view == null ? 0 : view.watching.length + view.rest;
      return Scaffold(
        appBar: AppBar(
          title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('领航'),
            if (view != null)
              Text(view.enabled ? '在替你跟 $followed 个对话 · ${view.waiting > 0 ? '${view.waiting} 件等你' : '没有要你管的'}' : '还没开始',
                  style: TextStyle(fontSize: 12, color: palette.text3, fontWeight: FontWeight.w400)),
          ]),
          actions: [
            if (view != null) ...[
              TextButton(onPressed: () => _rules(view), style: TextButton.styleFrom(minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 8)), child: Text('规矩', style: TextStyle(color: palette.text2))),
              // Read only: starting and stopping 领航 is done on the computer.
              Tooltip(message: '在电脑上的领航页开关', child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                decoration: BoxDecoration(color: (view.enabled ? palette.green : palette.text3).withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  _Dot(colour: view.enabled ? palette.green : palette.text3), const SizedBox(width: 5),
                  Text(view.enabled ? '在跟' : '已停', style: TextStyle(color: view.enabled ? palette.green : palette.text3, fontSize: 12.5, fontWeight: FontWeight.w600)),
                ]),
              )),
              const SizedBox(width: 12),
            ],
          ],
        ),
        body: _body(palette, view),
      );
    });
  }

  Widget _body(Palette palette, LeadView? view) {
    if (view == null) {
      if (lead.missing) return _centered(palette, '这个后端还没有领航', '把电脑上的 CoderFleet 升级到和 App 一样的版本就有了。');
      return Center(child: lead.error == null ? const CircularProgressIndicator.adaptive() : Text(lead.error!, style: TextStyle(color: palette.text3)));
    }
    final projects = _projects(view);
    if (!projects.contains(only)) only = '';
    final shown = view.items.where((item) => only.isEmpty || item.projectId.isEmpty || item.projectId == only).toList();
    final status = view.draft.isNotEmpty
        ? '领航正在输入…'
        : view.working == null
            ? null
            : view.step.isNotEmpty
                ? '领航${view.step}…'
                : '领航在看${view.working!.isEmpty ? '' : '「${view.working}」'}…';
    // Newest at the bottom: the list runs upwards from its end.
    final rows = <Widget>[
      if (view.items.isEmpty) _hello(palette, view),
      for (final item in shown) _item(item),
      if (view.draft.isNotEmpty) Answer(key: const ValueKey('draft'), text: view.draft, onConversation: openConversation),
      if (status != null) _Working(key: const ValueKey('working'), text: status),
    ].reversed.toList();
    return Column(children: [
      if (lead.error != null)
        Container(width: double.infinity, color: palette.amber.withValues(alpha: 0.12), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Text('连接中断，正在重连…', style: TextStyle(color: palette.amber, fontSize: 13))),
      if (view.enabled && view.configured) _watch(palette, view, projects),
      Expanded(child: Align(alignment: Alignment.topCenter, child: ListView(
        controller: scroller, reverse: true, shrinkWrap: true, keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 8), children: rows,
      ))),
      _composer(palette, view),
    ]);
  }

  Widget _centered(Palette palette, String title, String text) => Center(child: Padding(padding: const EdgeInsets.all(32), child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.explore_outlined, size: 36, color: palette.text3),
        const SizedBox(height: 12),
        Text(title, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: palette.text)),
        Padding(padding: const EdgeInsets.only(top: 6), child: Text(text, textAlign: TextAlign.center, style: TextStyle(color: palette.text2, height: 1.5))),
      ])));

  Widget _hello(Palette palette, LeadView view) => Padding(
        key: const ValueKey('hello'), padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 8),
        child: Column(children: [
          Icon(Icons.explore_outlined, size: 30, color: palette.accent),
          const SizedBox(height: 10),
          Text('领航', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: palette.text)),
          const SizedBox(height: 6),
          Text(view.enabled ? '现在没有要你定的事。哪个对话停下来等你，我先看；我定不了的，会在这里跟你说。'
              : '你同时开着好几个对话的时候，它替你盯着：能定的小事它定，拿不准的、删除推送这类要紧的，它拿来问你。它自己不改代码。',
              textAlign: TextAlign.center, style: TextStyle(color: palette.text2, height: 1.5)),
        ]),
      );

  Widget _item(LeadItem item) {
    final key = ValueKey(item.id);
    return switch (item.type) {
      'user' => Padding(key: key, padding: const EdgeInsets.only(top: 4), child: UserMessage(text: item.text, images: item.attachments, cache: images)),
      'lead' => Answer(key: key, text: item.text, onConversation: openConversation),
      'note' => Padding(key: key, padding: const EdgeInsets.symmetric(vertical: 6), child: Center(child: Text(item.text, textAlign: TextAlign.center, style: TextStyle(color: context.palette.text3, fontSize: 12.5)))),
      'did' => _DidRow(key: key, item: item, images: images, colour: _colour(item.projectId), onOpen: () => openConversation(item.conversationId),
          onUndo: () => act(() => widget.client.leadUndo(item.id))),
      'seen' => _NoteLine(key: key, item: item, colour: _colour(item.projectId), before: '「', after: '」做完了，我看过，没有留事情给你'),
      'ask' => _AskCard(key: key, item: item, colour: _colour(item.projectId), onOpen: () => openConversation(item.conversationId),
          onAnswer: ({String? answer, Map<String, String>? answers}) async {
            final done = await act(() => widget.client.leadAnswer(item.id, answer: answer, answers: answers));
            // 「我去看」: the user goes to the conversation.
            if (done && answer == leadMine && mounted) openConversation(item.conversationId);
            return done;
          },
          // Its own view is carried out by telling it so, like any other sentence to it.
          onAgree: () => say('「${item.conversation}」这件按你说的办')),
      _ => SizedBox.shrink(key: key),
    };
  }

  /// The conversations 领航 follows, by project; a project chip narrows the page to it.
  Widget _watch(Palette palette, LeadView view, List<String> projects) {
    final list = view.watching;
    final groups = {for (final item in list) item.projectId}.toList();
    final running = list.where((item) => item.status == 'running').length;
    int waits(String projectId) => view.items.where((item) => item.open && (projectId.isEmpty || item.projectId == projectId)).length;
    Widget chip(String projectId, String label) {
      final count = waits(projectId);
      return Padding(padding: const EdgeInsets.only(right: 6), child: ChoiceChip(
        visualDensity: VisualDensity.compact, selected: only == projectId, onSelected: (_) => setState(() => only = projectId),
        avatar: projectId.isEmpty ? null : _Dot(colour: _colour(projectId)),
        label: Text(count > 0 ? '$label $count' : label, style: const TextStyle(fontSize: 12.5)),
      ));
    }
    final sum = [if (running > 0) '$running 个在跑', view.waiting > 0 ? '${view.waiting} 件等你' : '没有要你管的'].join(' · ');
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: palette.line)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () => setState(() => folded = !folded),
          child: Padding(padding: const EdgeInsets.fromLTRB(12, 10, 8, 10), child: Row(children: [
            Text('正在跟的对话', style: TextStyle(fontWeight: FontWeight.w600, color: palette.text, fontSize: 14)),
            const SizedBox(width: 8),
            Expanded(child: Text(sum, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text3, fontSize: 12.5))),
            Icon(folded ? Icons.expand_more : Icons.expand_less, size: 20, color: palette.text3),
          ])),
        ),
        if (!folded) ...[
          if (projects.length > 1)
            SizedBox(height: 40, child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 10), children: [
              chip('', '全部'), for (final projectId in projects) chip(projectId, projectId),
            ])),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.3),
            child: ListView(shrinkWrap: true, padding: const EdgeInsets.only(bottom: 8), children: [
              for (final projectId in groups.where((id) => only.isEmpty || id == only)) ...[
                Padding(padding: const EdgeInsets.fromLTRB(12, 6, 12, 2), child: Row(children: [
                  _Dot(colour: _colour(projectId)), const SizedBox(width: 6),
                  Text(projectId, style: TextStyle(color: palette.text2, fontSize: 12.5, fontWeight: FontWeight.w600)),
                  const SizedBox(width: 6),
                  Text('${list.where((item) => item.projectId == projectId).length} 个对话', style: TextStyle(color: palette.text3, fontSize: 12)),
                ])),
                for (final item in list.where((item) => item.projectId == projectId)) _WatchRow(item: item, onTap: () => openConversation(item.id)),
              ],
              Padding(padding: const EdgeInsets.fromLTRB(12, 6, 12, 0), child: Text(
                  list.isEmpty ? '现在没有在跑或等你的对话，有动静我会接。' : view.rest > 0 ? '其余 ${view.rest} 个对话停着，有动静我会接。' : '',
                  style: TextStyle(color: palette.text3, fontSize: 12))),
            ]),
          ),
        ],
      ]),
    );
  }

  Widget _composer(Palette palette, LeadView view) {
    final notice = !view.configured
        ? ('领航要用系统模型来判断', '先在电脑上的 设置 → 通用 里填好系统模型。')
        : !view.enabled
            ? ('领航还没开始', '在电脑上的领航页打开它：之后对话里的批准和问题先到它这里。')
            : null;
    final ready = view.configured && !sending;
    final canSend = ready && !attachments.uploading && (input.text.trim().isNotEmpty || !attachments.isEmpty);
    return SafeArea(top: false, child: Padding(padding: const EdgeInsets.fromLTRB(10, 4, 10, 8), child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (notice != null)
        Container(margin: const EdgeInsets.only(bottom: 8), padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: palette.amber.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
            child: Text.rich(TextSpan(children: [
              TextSpan(text: '${notice.$1}  ', style: const TextStyle(fontWeight: FontWeight.w600)),
              TextSpan(text: notice.$2),
            ]), style: TextStyle(color: palette.amber, fontSize: 13, height: 1.45))),
      Container(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        decoration: BoxDecoration(color: palette.surface, borderRadius: BorderRadius.circular(22),
            boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.07), blurRadius: 20, offset: const Offset(0, 4))]),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (!attachments.isEmpty) AttachmentRow(attachments: attachments),
          TextField(
            controller: input, minLines: 1, maxLines: 6, enabled: view.configured, textInputAction: TextInputAction.newline,
            decoration: const InputDecoration(
              hintText: '直接说就行：交代一件事，或者一句话回它问你的几件事…',
              border: InputBorder.none, enabledBorder: InputBorder.none, focusedBorder: InputBorder.none, disabledBorder: InputBorder.none,
              filled: false, contentPadding: EdgeInsets.symmetric(vertical: 6),
            ),
          ),
          Row(children: [
            IconButton(icon: Icon(Icons.attach_file, color: palette.text2), tooltip: '添加附件', visualDensity: VisualDensity.compact,
                onPressed: view.configured ? () => showAttachMenu(context, (from) => attachments.add(context, from, widget.attachmentSource)) : null),
            const SizedBox(width: 2),
            Expanded(child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: [
              for (final hint in _hints)
                Padding(padding: const EdgeInsets.only(right: 6), child: GestureDetector(
                  onTap: ready ? () => say(hint) : null,
                  child: Container(height: 30, padding: const EdgeInsets.symmetric(horizontal: 10), alignment: Alignment.center,
                      decoration: BoxDecoration(color: palette.fill, borderRadius: BorderRadius.circular(15)),
                      child: Text(hint, style: TextStyle(fontSize: 13, color: palette.text2))),
                )),
            ]))),
            const SizedBox(width: 6),
            Tooltip(message: '发送', child: Material(
              color: canSend ? palette.ink : palette.fill, shape: const CircleBorder(),
              child: InkWell(customBorder: const CircleBorder(), onTap: canSend ? () => say(input.text, typed: true) : null,
                  child: SizedBox(width: 36, height: 36, child: Icon(Icons.arrow_upward_rounded, size: 20, color: canSend ? palette.inkText : palette.text3))),
            )),
          ]),
        ]),
      ),
    ])));
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.colour});
  final Color colour;
  @override
  Widget build(BuildContext context) => Container(width: 8, height: 8, decoration: BoxDecoration(color: colour, shape: BoxShape.circle));
}

/// What 领航 is doing right now: writing its answer, or which conversation it is looking at.
class _Working extends StatelessWidget {
  const _Working({super.key, required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Row(children: [
      SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: palette.accent)),
      const SizedBox(width: 8),
      Expanded(child: Text(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.accent, fontWeight: FontWeight.w500))),
    ]));
  }
}

/// One followed conversation: where it stands, and since when.
class _WatchRow extends StatelessWidget {
  const _WatchRow({required this.item, required this.onTap});
  final LeadWatch item;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final colour = item.status == 'waiting' ? palette.amber : item.status == 'failed' ? palette.red : palette.accent;
    return InkWell(onTap: onTap, child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      child: Row(children: [
        SizedBox(width: 14, child: Center(child: item.status == 'running'
            ? SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.4, color: colour))
            : Container(width: 7, height: 7, decoration: BoxDecoration(color: colour, shape: BoxShape.circle)))),
        const SizedBox(width: 6),
        Expanded(child: Text(item.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text, fontSize: 14))),
        if (item.account.isNotEmpty) Padding(padding: const EdgeInsets.only(left: 6), child: Text(item.account, style: TextStyle(color: palette.text3, fontSize: 12))),
        const SizedBox(width: 8),
        ConstrainedBox(constraints: const BoxConstraints(maxWidth: 140), child: Text(item.note, maxLines: 1, overflow: TextOverflow.ellipsis,
            style: TextStyle(color: colour, fontSize: 12.5, fontWeight: FontWeight.w500))),
        if (item.at != null) Padding(padding: const EdgeInsets.only(left: 6), child: Text(relativeTime(item.at!), style: TextStyle(color: palette.text3, fontSize: 12))),
      ]),
    ));
  }
}

/// A line about a conversation, faint: project, then the words with its name in bold.
class _NoteLine extends StatelessWidget {
  const _NoteLine({super.key, required this.item, required this.colour, required this.before, required this.after, this.undone = false});
  final LeadItem item;
  final Color colour;
  final String before, after;
  final bool undone;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final style = TextStyle(color: palette.text3, fontSize: 13, height: 1.45, decoration: undone ? TextDecoration.lineThrough : null);
    return Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.only(top: 6), child: _Dot(colour: colour)),
      const SizedBox(width: 6),
      Expanded(child: Text.rich(TextSpan(children: [
        TextSpan(text: '${item.projectId}  ', style: style.copyWith(fontSize: 12)),
        TextSpan(text: before),
        TextSpan(text: item.conversation, style: TextStyle(fontWeight: FontWeight.w600, color: palette.text2)),
        TextSpan(text: after),
      ]), style: style)),
    ]));
  }
}

/// What 领航 settled by itself: one faint line; its grounds open below, and what can be taken back has 撤回.
class _DidRow extends StatefulWidget {
  const _DidRow({super.key, required this.item, required this.images, required this.colour, required this.onOpen, required this.onUndo});
  final LeadItem item;
  final UploadCache images;
  final Color colour;
  final VoidCallback onOpen;
  final Future<bool> Function() onUndo;
  @override
  State<_DidRow> createState() => _DidRowState();
}

class _DidRowState extends State<_DidRow> {
  bool open = false, busy = false;

  static (String, String) words(LeadItem item) => switch (item.action) {
        'approve' => ('「', '」要做的操作我批了：${_clip(item.asked, 80)}'),
        'answer' => ('「', '」问的我答了：${_clip(item.said, 80)}'),
        'reply' => ('我回了「', '」：${_clip(item.said, 80)}'),
        'accept' => ('「', '」我收下了，让它合并'),
        'stop' => ('我让「', '」停下了'),
        'start' => ('开了新对话「', '」：${_clip(item.said, 80)}${item.attachments.isEmpty ? '' : '（带了 ${item.attachments.length} 个附件）'}'),
        _ => ('「', '」${item.action}'),
      };

  @override
  Widget build(BuildContext context) {
    final palette = context.palette, item = widget.item;
    final (before, after) = words(item);
    Widget link(String label, VoidCallback? onTap, {Color? colour}) => TextButton(
          onPressed: onTap,
          style: TextButton.styleFrom(minimumSize: const Size(0, 30), padding: const EdgeInsets.symmetric(horizontal: 8), visualDensity: VisualDensity.compact, tapTargetSize: MaterialTapTargetSize.shrinkWrap),
          child: Text(label, style: TextStyle(fontSize: 12.5, color: colour ?? palette.text2)),
        );
    Widget part(String title, Widget body) => Padding(padding: const EdgeInsets.only(top: 6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: TextStyle(color: palette.text3, fontSize: 12, fontWeight: FontWeight.w600)), const SizedBox(height: 2), body,
        ]));
    final small = TextStyle(color: palette.text2, fontSize: 13, height: 1.45);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _NoteLine(item: item, colour: widget.colour, before: before, after: after, undone: item.undone),
      Padding(padding: const EdgeInsets.only(left: 8), child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
        if (item.undone) Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Text('已撤回', style: TextStyle(color: palette.text3, fontSize: 12))),
        link(open ? '收起' : '依据', () => setState(() => open = !open)),
        link('打开对话', widget.onOpen),
        if (item.canUndo)
          link('撤回', busy ? null : () async {
            setState(() => busy = true);
            await widget.onUndo();
            if (mounted) setState(() => busy = false);
          }, colour: palette.red),
      ])),
      if (open)
        Container(
          margin: const EdgeInsets.fromLTRB(14, 0, 0, 6), padding: const EdgeInsets.fromLTRB(10, 0, 0, 6),
          decoration: BoxDecoration(border: Border(left: BorderSide(color: palette.line, width: 2))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (item.asked.isNotEmpty) part('它问', SelectableText(item.asked, style: small)),
            if (item.evidence.isNotEmpty) part('我进项目里看了', _Evidence(list: item.evidence)),
            if (item.said.isNotEmpty) part(item.action == 'start' ? '我交代的' : '我回', SelectableText(item.said, style: small)),
            if (item.attachments.isNotEmpty) part('一起交过去的附件', _Files(paths: item.attachments, images: widget.images)),
            if (item.reason.isNotEmpty) part('依据', SelectableText(item.reason, style: small)),
          ]),
        ),
    ]);
  }
}

/// Files 领航 handed over: images open full screen, other files show their name.
class _Files extends StatelessWidget {
  const _Files({required this.paths, required this.images});
  final List<String> paths;
  final UploadCache images;
  @override
  Widget build(BuildContext context) => Wrap(spacing: 6, runSpacing: 6, children: [
        for (final path in paths) isImageUpload(path) ? Thumb(path: path, cache: images, size: 72) : FileChip(name: uploadName(path), height: 44),
      ]);
}

class _Evidence extends StatelessWidget {
  const _Evidence({required this.list});
  final List<LeadEvidence> list;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final item in list)
        Container(
          margin: const EdgeInsets.only(top: 4), padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: palette.code, borderRadius: BorderRadius.circular(10)),
          child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Text('\$ ${item.command}\n${item.output.isEmpty ? '（没有输出）' : item.output}',
              style: mono.copyWith(color: const Color(0xFFE3E7EF), fontSize: 12))),
        ),
    ]);
  }
}

typedef LeadAnswer = Future<bool> Function({String? answer, Map<String, String>? answers});

/// Something 领航 hands to the user, answered here: one of its options, a question's picks, or (when it takes any text) a reply passed on as written.
class _AskCard extends StatefulWidget {
  const _AskCard({super.key, required this.item, required this.colour, required this.onOpen, required this.onAnswer, required this.onAgree});
  final LeadItem item;
  final Color colour;
  final VoidCallback onOpen;
  final LeadAnswer onAnswer;
  final Future<void> Function() onAgree;
  @override
  State<_AskCard> createState() => _AskCardState();
}

class _AskCardState extends State<_AskCard> with AutomaticKeepAliveClientMixin {
  // What the user is part way through stays when the thread redraws or scrolls.
  final Map<String, Set<String>> picked = {};
  final reply = TextEditingController();
  bool busy = false, quote = false, evidence = false;

  @override
  bool get wantKeepAlive => widget.item.open;

  @override
  void didUpdateWidget(covariant _AskCard old) {
    super.didUpdateWidget(old);
    if (old.item.open != widget.item.open) updateKeepAlive();
  }

  @override
  void dispose() {
    reply.dispose();
    super.dispose();
  }

  Future<void> _answer({String? answer, Map<String, String>? answers}) async {
    setState(() => busy = true);
    final done = await widget.onAnswer(answer: answer, answers: answers);
    if (!mounted) return;
    setState(() => busy = false);
    if (done) reply.clear();
  }

  static const _titles = {'approval': '要做一个操作，等你批准', 'question': '问你', 'finished': '停下来等你', 'job': '一件活等你定', 'failed': '这一轮失败了'};
  static const _icons = {'approval': Icons.shield_outlined, 'question': Icons.help_outline, 'finished': Icons.chat_bubble_outline, 'job': Icons.task_alt, 'failed': Icons.error_outline};

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final palette = context.palette, item = widget.item;
    // Written before the answer was kept apart from the question.
    final old = item.kind == 'finished' && item.quote == null;
    final original = old ? item.asked : item.quote ?? '';
    final text = TextStyle(color: palette.text, fontSize: 14.5, height: 1.5);
    final mine = TextStyle(color: palette.text2, fontSize: 13.5, height: 1.5);
    Widget toggle(String label, bool on, VoidCallback onTap) => Align(alignment: Alignment.centerLeft, child: TextButton.icon(
          onPressed: onTap, icon: Icon(on ? Icons.expand_less : Icons.expand_more, size: 16), label: Text(label, style: const TextStyle(fontSize: 13)),
          style: TextButton.styleFrom(foregroundColor: palette.text3, padding: const EdgeInsets.symmetric(horizontal: 4), minimumSize: const Size(0, 30), visualDensity: VisualDensity.compact),
        ));
    final body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Align(alignment: Alignment.centerLeft, child: InkWell(
        onTap: widget.onOpen, borderRadius: BorderRadius.circular(8),
        child: Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(mainAxisSize: MainAxisSize.min, children: [
          _Dot(colour: widget.colour), const SizedBox(width: 6),
          Flexible(child: Text('「${item.conversation}」', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.accent, fontWeight: FontWeight.w600, fontSize: 14))),
          Icon(Icons.chevron_right, size: 16, color: palette.accent),
        ])),
      )),
      const SizedBox(height: 4),
      SelectableText(old ? item.why : item.asked, style: text),
      if (!old && item.why.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(item.why, style: mine)),
      if (item.lean.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(item.lean, style: mine)),
      if (original.isNotEmpty) ...[
        toggle('它的原话', quote, () => setState(() => quote = !quote)),
        if (quote) Answer(text: original),
      ],
      if (item.evidence.isNotEmpty) ...[
        toggle('我看了项目里 ${item.evidence.length} 处', evidence, () => setState(() => evidence = !evidence)),
        if (evidence) _Evidence(list: item.evidence),
      ],
      if (item.resolved != null)
        Padding(padding: const EdgeInsets.only(top: 8), child: Text(item.resolved!.byUser ? '你说：${item.resolved!.answer}' : '已经在对话里处理了',
            style: TextStyle(color: palette.text3, fontSize: 13, fontWeight: FontWeight.w500))),
      if (item.open && item.questions.isNotEmpty) ..._questions(palette),
      if (item.open && item.questions.isEmpty && item.free)
        Padding(padding: const EdgeInsets.only(top: 10), child: Row(children: [
          Expanded(child: TextField(controller: reply, minLines: 1, maxLines: 4, enabled: !busy, onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(hintText: '回复它（原样转给这个对话）'))),
          const SizedBox(width: 8),
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
            onPressed: busy || reply.text.trim().isEmpty ? null : () => _answer(answer: reply.text.trim()), child: const Text('回复')),
        ])),
    ]);
    final List<Widget> actions;
    if (!item.open) {
      actions = const [];
    } else if (item.questions.isNotEmpty) {
      final answers = _answers();
      actions = [FilledButton(onPressed: busy || answers.length != item.questions.length ? null : () => _answer(answers: answers), child: const Text('提交回答'))];
    } else {
      const primary = {leadAllow, leadAccept, leadRetry};
      actions = [
        if (item.free && item.lean.isNotEmpty) OutlinedButton(onPressed: busy ? null : widget.onAgree, child: const Text('按你说的办')),
        for (final option in item.options)
          primary.contains(option)
              ? FilledButton(onPressed: busy ? null : () => _answer(answer: option), child: Text(option))
              : OutlinedButton(onPressed: busy ? null : () => _answer(answer: option), child: Text(option)),
      ];
    }
    return Opacity(
      opacity: item.open ? 1 : 0.72,
      child: ActionCard(icon: _icons[item.kind] ?? Icons.flag_outlined, title: _titles[item.kind] ?? '等你', subtitle: item.projectId, body: body, actions: actions, palette: palette),
    );
  }

  Map<String, String> _answers() => {
        for (final question in widget.item.questions)
          if (picked[question.question]?.isNotEmpty ?? false) question.question: picked[question.question]!.join(', '),
      };

  List<Widget> _questions(Palette palette) => [
        for (final question in widget.item.questions) ...[
          Padding(padding: const EdgeInsets.only(top: 10, bottom: 6), child: Text(question.question, style: TextStyle(color: palette.text, fontWeight: FontWeight.w500))),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final option in question.options)
              ChoiceChip(
                label: Text(option.label), tooltip: option.description.isEmpty ? null : option.description,
                selected: picked[question.question]?.contains(option.label) ?? false,
                onSelected: busy ? null : (selected) => setState(() {
                  final set = picked.putIfAbsent(question.question, () => {});
                  if (!question.multiSelect) set.clear();
                  if (selected) { set.add(option.label); } else { set.remove(option.label); }
                }),
              ),
          ]),
        ],
      ];
}
