// Home: the backend's conversations in sections (waiting for you, today,
// yesterday, earlier), each with its state and the line its latest answer ended
// on, a page at a time (more as the list is scrolled to its end); pulling down
// refreshes; search runs on the backend; a new conversation starts from a
// project picker; 领航's thread opens from the top bar.
import 'dart:async';

// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';

import '../backend.dart';
import '../models.dart';
import '../notifications.dart';
import '../state.dart';
import 'chat_screen.dart';
import 'connect_screen.dart';
import 'lead_screen.dart';
import 'theme.dart';

class ConversationsScreen extends StatefulWidget {
  const ConversationsScreen({super.key, required this.state, this.feedWait = const Duration(seconds: 25), this.notifier});
  final AppState state;
  final Duration feedWait;
  final Notifier? notifier;
  @override
  State<ConversationsScreen> createState() => _ConversationsScreenState();
}

class _ConversationsScreenState extends State<ConversationsScreen> with WidgetsBindingObserver {
  ConversationFeed? feed;
  bool searching = false;
  Timer? _typing;
  bool _chatOpen = false;
  late final BackgroundWatch? _watch = widget.notifier == null ? null : BackgroundWatch(widget.notifier!);
  StreamSubscription<String>? _taps;
  String? _pendingOpen;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _attach();
    _taps = widget.notifier?.taps.listen(_openTapped);
    unawaited(widget.notifier?.init().catchError((_) {}));
  }

  @override
  void didUpdateWidget(covariant ConversationsScreen old) {
    super.didUpdateWidget(old);
    if (feed?.client != widget.state.client) _attach();
  }

  void _attach() {
    _watch?.stop();
    feed?.removeListener(_openPending);
    feed?.dispose();
    _typing?.cancel();
    searching = false;
    final client = widget.state.client;
    feed = client == null ? null : (ConversationFeed(client, wait: widget.feedWait)..addListener(_openPending)..start());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _watch?.stop();
      _chatOpen ? feed?.stop() : feed?.start();
    } else if (state == AppLifecycleState.paused) {
      // In the background the list keeps polling (as long as the OS lets the app run) to notify.
      if (_watch == null) {
        feed?.stop();
      } else if (feed != null) {
        // A search shows part of the list: watch all of it, starting from its next answer.
        final whole = feed!.query.isEmpty;
        _endSearch();
        _watch.start(feed!, current: !_chatOpen && whole);
        if (_chatOpen) feed!.resync();
        feed!.start();
      }
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _taps?.cancel();
    _typing?.cancel();
    _watch?.stop();
    feed?.dispose();
    super.dispose();
  }

  /// Searches once typing pauses, so each letter is not a request.
  void _search(String value) {
    _typing?.cancel();
    _typing = Timer(const Duration(milliseconds: 250), () => feed?.search(value.trim().toLowerCase()));
  }

  void _endSearch() {
    _typing?.cancel();
    feed?.search('');
    if (searching && mounted) setState(() => searching = false);
  }

  /// A tapped notification: back to the list, then into its conversation once the list has it.
  void _openTapped(String conversationId) {
    if (!mounted) return;
    Navigator.of(context).popUntil((route) => route.isFirst);
    // What notified is among the latest conversations, which a search may hide.
    _endSearch();
    _pendingOpen = conversationId;
    _openPending();
  }

  void _openPending() {
    final id = _pendingOpen, current = feed;
    if (id == null || current == null || !current.loaded || current.pending || !mounted) return;
    _pendingOpen = null;
    final conversation = current.conversations.where((item) => item.id == id).firstOrNull;
    if (conversation == null) {
      showMessage(context, '这个对话已不存在，或不在当前后端上');
      return;
    }
    _open(conversation: conversation);
  }

  void _open({Conversation? conversation, Project? project, String? account}) {
    final client = widget.state.client, current = feed;
    if (client == null || current == null) return;
    feed?.stop();
    _chatOpen = true;
    Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => ChatScreen(client: client, feed: current, conversation: conversation, projectId: project?.id ?? conversation!.projectId, account: account)))
        .then((_) {
          _chatOpen = false;
          if (mounted) feed?.start();
        });
  }

  /// 领航's thread; like a conversation, the list stops polling while it is open.
  void _lead() {
    final client = widget.state.client, current = feed;
    if (client == null || current == null) return;
    current.stop();
    _chatOpen = true;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => LeadScreen(client: client, feed: current, wait: widget.feedWait))).then((_) {
      _chatOpen = false;
      if (mounted) feed?.start();
    });
  }

  Future<void> _newChat() async {
    final current = feed;
    if (current == null) return;
    if (current.projects.isEmpty) await current.refreshProjects().catchError((_) {});
    if (!mounted) return;
    final projects = current.projects.where((item) => item.canChat).toList()
      ..sort((a, b) => a.running != b.running ? (a.running ? -1 : 1) : a.name.compareTo(b.name));
    final picked = await showModalBottomSheet<Project>(context: context, isScrollControlled: true, builder: (context) => ProjectPicker(projects: projects));
    if (picked == null || !mounted) return;
    // A project with several accounts: the conversation is with one of them, chosen here.
    if (picked.choices.isEmpty) return _open(project: picked);
    final account = await showModalBottomSheet<ProjectAccount>(context: context, isScrollControlled: true, builder: (context) => AccountPicker(project: picked));
    if (account != null) _open(project: picked, account: account.name);
  }

  void _backends() {
    final state = widget.state;
    showModalBottomSheet<void>(context: context, builder: (sheet) {
      final palette = sheet.palette;
      return SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
        for (final profile in state.profiles)
          ListTile(
            leading: Icon(profile.id == state.current?.id ? Icons.check_circle : Icons.circle_outlined, color: profile.id == state.current?.id ? palette.green : palette.text3),
            title: Text(profile.name),
            subtitle: Text(profile.addresses.join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text3, fontSize: 12)),
            onTap: () { Navigator.pop(sheet); state.switchTo(profile); },
            trailing: IconButton(icon: const Icon(Icons.more_horiz), onPressed: () { Navigator.pop(sheet); _editBackend(profile); }),
          ),
        ListTile(leading: const Icon(Icons.add), title: const Text('添加后端'), onTap: () {
          Navigator.pop(sheet);
          Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConnectScreen(state: state, canClose: true)));
        }),
      ]));
    });
  }

  Future<void> _editBackend(Profile profile) async {
    final addresses = [...profile.addresses];
    final input = TextEditingController();
    final saved = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (sheet) => StatefulBuilder(builder: (sheet, setSheet) {
      final palette = sheet.palette;
      String? error;
      return Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(sheet).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(profile.name, style: Theme.of(sheet).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('按顺序尝试，用第一个连得上的。', style: TextStyle(color: palette.text3, fontSize: 12.5)),
          const SizedBox(height: 8),
          ReorderableListView(shrinkWrap: true, buildDefaultDragHandles: true, onReorderItem: (from, to) => setSheet(() {
            addresses.insert(to, addresses.removeAt(from));
          }), children: [
            for (final address in addresses)
              ListTile(key: ValueKey(address), dense: true, contentPadding: EdgeInsets.zero, title: Text(address, style: mono),
                  trailing: IconButton(icon: const Icon(Icons.close, size: 18), onPressed: addresses.length > 1 ? () => setSheet(() => addresses.remove(address)) : null)),
          ]),
          Row(children: [
            Expanded(child: TextField(controller: input, keyboardType: TextInputType.url, autocorrect: false, decoration: InputDecoration(hintText: '添加地址', errorText: error))),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: () => setSheet(() {
              try {
                final url = checkAddress(input.text);
                if (!addresses.contains(url)) addresses.add(url);
                input.clear();
              } on BackendError catch (failure) {
                showMessage(context, failure.message);
              }
            }), child: const Text('添加')),
          ]),
          const SizedBox(height: 16),
          FilledButton(onPressed: () => Navigator.pop(sheet, true), child: const Text('保存')),
          TextButton(onPressed: () async {
            Navigator.pop(sheet, false);
            await widget.state.remove(profile);
          }, child: Text('从手机上移除', style: TextStyle(color: palette.red))),
        ]),
      );
    }));
    if (saved == true) await widget.state.update(profile.copyWith(addresses: addresses));
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final current = feed;
    return Scaffold(
      appBar: AppBar(
        title: searching
            ? TextField(autofocus: true, decoration: const InputDecoration(hintText: '搜索对话', border: InputBorder.none, filled: false), onChanged: _search)
            : GestureDetector(onTap: _backends, child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text(widget.state.current?.name ?? 'CoderFleet'),
                const SizedBox(width: 4),
                Icon(Icons.expand_more, size: 20, color: palette.text3),
              ])),
        actions: [
          IconButton(icon: Icon(searching ? Icons.close : Icons.search), onPressed: () => searching ? _endSearch() : setState(() => searching = true)),
          if (!searching) IconButton(icon: const Icon(Icons.explore_outlined), tooltip: '领航', onPressed: _lead),
          if (!searching) IconButton(icon: const Icon(Icons.edit_outlined), tooltip: '新对话', onPressed: _newChat),
        ],
      ),
      body: current == null
          ? const SizedBox()
          : ListenableBuilder(listenable: current, builder: (context, _) {
              if (current.unauthorized) {
                return _Notice(icon: Icons.lock_outline, title: '这台手机已被移除', text: current.error ?? '', action: ('重新连接', () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConnectScreen(state: widget.state, canClose: true)))));
              }
              if (!current.loaded) {
                return current.error != null
                    ? _Notice(icon: Icons.wifi_off, title: '连不上后端', text: '${current.error}\n会自动重试。也可以检查手机的网络，或在后端设置里调整地址。', action: ('后端设置', _backends))
                    : const Center(child: CircularProgressIndicator.adaptive());
              }
              final list = current.conversations, query = current.query;
              return Column(children: [
                if (current.error != null)
                  Container(width: double.infinity, color: palette.amber.withValues(alpha: 0.12), padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      child: Text('连接中断，正在重连…', style: TextStyle(color: palette.amber, fontSize: 13))),
                Expanded(child: list.isEmpty
                    ? _Notice(icon: Icons.chat_bubble_outline, title: query.isEmpty ? '还没有对话' : '没有匹配的对话', text: query.isEmpty ? '点右上角的笔，选一个项目开始。' : '')
                    : RefreshIndicator.adaptive(
                        onRefresh: current.refresh,
                        child: ListView.builder(
                            physics: const AlwaysScrollableScrollPhysics(),
                            padding: const EdgeInsets.only(bottom: 24),
                            itemCount: list.length + (current.hasMore ? 1 : 0),
                            itemBuilder: (context, index) {
                              // The row after the last conversation: reaching it asks for the next page.
                              if (index == list.length) return _More(onShown: current.loadMore);
                              final item = list[index], now = DateTime.now();
                              final section = _section(item, now), first = index == 0 || _section(list[index - 1], now) != section;
                              return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                                if (first)
                                  Padding(padding: EdgeInsets.fromLTRB(16, index == 0 ? 8 : 20, 16, 4),
                                      child: Text(section, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: item.attention ? palette.amber : palette.text3)))
                                else
                                  Padding(padding: const EdgeInsets.only(left: 16), child: Divider(color: palette.line)),
                                _Row(conversation: item, project: _place(current.project(item.projectId), item), onTap: () => _open(conversation: item)),
                              ]);
                            }))),
              ]);
            }),
    );
  }
}

/// A spinner at the end of a list that has more: `onShown` runs when it scrolls into view.
class _More extends StatefulWidget {
  const _More({required this.onShown});
  final VoidCallback onShown;
  @override
  State<_More> createState() => _MoreState();
}

class _MoreState extends State<_More> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) widget.onShown(); });
  }

  @override
  Widget build(BuildContext context) => const Padding(padding: EdgeInsets.symmetric(vertical: 16), child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator.adaptive(strokeWidth: 2))));
}

/// The section a conversation is listed under: the ones waiting for the user first, the rest by day.
String _section(Conversation conversation, DateTime now) {
  if (conversation.attention) return '等你确认';
  final local = conversation.updatedAt.toLocal(), today = DateTime(now.year, now.month, now.day);
  if (!local.isBefore(today)) return '今天';
  if (!local.isBefore(today.subtract(const Duration(days: 1)))) return '昨天';
  return '更早';
}

/// One conversation: its name and time, the line its latest answer ended on, then its state (in words) and project.
class _Row extends StatelessWidget {
  const _Row({required this.conversation, required this.project, required this.onTap});
  final Conversation conversation;
  final String project;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final (color, label) = conversation.attention
        ? (palette.amber, '等你确认')
        : conversation.busy
            ? (palette.accent, '进行中')
            : conversation.status == 'failed'
                ? (palette.red, '失败')
                : (null, '');
    final small = TextStyle(color: palette.text3, fontSize: 12.5);
    return InkWell(onTap: onTap, child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Expanded(child: Text(conversation.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500, color: palette.text))),
          const SizedBox(width: 12),
          Text(relativeTime(conversation.updatedAt), style: small),
        ]),
        if (conversation.preview.isNotEmpty)
          Padding(padding: const EdgeInsets.only(top: 3), child: Text(conversation.preview, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: palette.text2, fontSize: 13.5))),
        Padding(padding: const EdgeInsets.only(top: 4), child: Row(children: [
          if (color != null) ...[
            Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
            const SizedBox(width: 5),
            Text(label, style: small.copyWith(color: color, fontWeight: FontWeight.w600)),
            Text(' · ', style: small),
          ],
          Expanded(child: Text(project, maxLines: 1, overflow: TextOverflow.ellipsis, style: small)),
        ])),
      ]),
    ));
  }
}

/// Where a conversation runs: its project, and which account when the project holds several.
String _place(Project? project, Conversation conversation) {
  if (project == null) return conversation.projectId;
  final account = project.accounts.length > 1 ? project.account(conversation.account) : null;
  return account == null ? project.name : '${project.name} · ${account.shortType}';
}

/// Which of the project's accounts a new conversation is with; the one used last comes checked.
class AccountPicker extends StatelessWidget {
  const AccountPicker({super.key, required this.project});
  final Project project;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text('用哪个账号？', style: Theme.of(context).textTheme.titleMedium)),
      for (final account in project.choices)
        ListTile(
          title: Text(account.typeLabel, style: TextStyle(color: palette.text)),
          subtitle: Text(account.note, style: TextStyle(color: palette.text3, fontSize: 12.5)),
          trailing: account.name == project.defaultAccount ? Icon(Icons.check, size: 20, color: palette.accent) : null,
          onTap: () => Navigator.pop(context, account),
        ),
    ]));
  }
}

class ProjectPicker extends StatefulWidget {
  const ProjectPicker({super.key, required this.projects});
  final List<Project> projects;
  @override
  State<ProjectPicker> createState() => _ProjectPickerState();
}

class _ProjectPickerState extends State<ProjectPicker> {
  String query = '';
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    final list = widget.projects.where((item) => query.isEmpty || item.name.toLowerCase().contains(query)).toList();
    return SafeArea(child: ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text('在哪个项目里对话？', style: Theme.of(context).textTheme.titleMedium)),
        if (widget.projects.length > 6)
          Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: TextField(
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '搜索项目'), onChanged: (value) => setState(() => query = value.trim().toLowerCase()))),
        Flexible(child: list.isEmpty
            ? Padding(padding: const EdgeInsets.all(24), child: Text('没有能对话的项目。在电脑上新建项目后再试。', style: TextStyle(color: palette.text3)))
            : ListView(shrinkWrap: true, children: [
                for (final project in list)
                  ListTile(
                    leading: Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: project.running ? palette.green : palette.line)),
                    title: Text(project.name, style: TextStyle(color: project.running ? palette.text : palette.text2)),
                    trailing: Text(project.running ? _types(project) : '${_types(project)} · 容器未运行', style: TextStyle(color: palette.text3, fontSize: 12.5)),
                    onTap: () => Navigator.pop(context, project),
                  ),
              ])),
      ]),
    ));
  }
}

String _types(Project project) => project.accounts.length > 1 ? project.accounts.map((item) => item.shortType).join(' + ') : project.typeLabel;

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.title, required this.text, this.action});
  final IconData icon;
  final String title, text;
  final (String, VoidCallback)? action;
  @override
  Widget build(BuildContext context) {
    final palette = context.palette;
    return Center(child: Padding(padding: const EdgeInsets.all(32), child: Column(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, size: 36, color: palette.text3),
      const SizedBox(height: 12),
      Text(title, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: palette.text)),
      if (text.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(text, textAlign: TextAlign.center, style: TextStyle(color: palette.text2, height: 1.5))),
      if (action != null) Padding(padding: const EdgeInsets.only(top: 16), child: OutlinedButton(onPressed: action!.$2, child: Text(action!.$1))),
    ])));
  }
}
