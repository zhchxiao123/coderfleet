// Shapes of the CoderFleet Node backend's chat API (node-app/src/server.ts).
// Parsing is lenient: unknown or missing fields fall back to empty values.

Map<String, dynamic> _map(Object? value) => value is Map ? value.cast<String, dynamic>() : const {};
List<Map<String, dynamic>> _maps(Object? value) => value is List ? value.whereType<Map>().map((item) => item.cast<String, dynamic>()).toList() : const [];
String _text(Object? value) => value is String ? value : '';
List<String> _strings(Object? value) => value is List ? value.whereType<String>().toList() : const [];

/// One of the accounts a project holds. `used`: how full its fullest quota window is, in percent (null when unknown).
class ProjectAccount {
  ProjectAccount({required this.name, required this.type, required this.typeLabel, required this.chat, required this.signedIn, this.used});
  factory ProjectAccount.fromJson(Map<String, dynamic> json) => ProjectAccount(
        name: _text(json['name']), type: _text(json['type']), typeLabel: _text(json['typeLabel']),
        chat: json['chat'] == true, signedIn: json['signedIn'] != false, used: json['used'] is num ? (json['used'] as num).round() : null);
  final String name, type, typeLabel;
  final bool chat, signedIn;
  final int? used;
  /// The type in one word ("Claude Code" → "Claude").
  String get shortType => typeLabel.split(' ').first;
  String get note => [name, if (!signedIn) '未登录' else if (used != null) '已用 $used%'].join(' · ');
}

class Project {
  Project({required this.id, required this.name, required this.type, required this.typeLabel, required this.state, required this.chat, required this.active,
      this.accounts = const [], this.defaultAccount = ''});
  factory Project.fromJson(Map<String, dynamic> json) => Project(
        id: _text(json['id']), name: _text(json['name']), type: _text(json['type']), typeLabel: _text(json['typeLabel']),
        state: _text(json['state']), chat: json['chat'] == true, active: json['active'] != false,
        accounts: _maps(json['accounts']).map(ProjectAccount.fromJson).toList(), defaultAccount: _text(json['defaultAccount']));
  final String id, name, type, typeLabel, state;
  final bool chat, active;
  /// The accounts the project holds (empty from a backend that knows one account per project) and
  /// the one a new conversation starts with unless another is picked.
  final List<ProjectAccount> accounts;
  final String defaultAccount;
  bool get running => state == 'running';
  bool get canChat => chat && active;
  /// The accounts a conversation can be started with, when there is a choice.
  List<ProjectAccount> get choices => accounts.length > 1 ? accounts.where((item) => item.chat).toList() : const [];
  ProjectAccount? account(String? name) => accounts.where((item) => item.name == name).firstOrNull;
  /// What a conversation of this project is labelled with: the type of the account it uses.
  String label(String? accountName) => account(accounts.length > 1 ? accountName : null)?.typeLabel ?? typeLabel;
}

class ModelOption {
  ModelOption(this.id, this.label);
  final String id, label;
}

class Conversation {
  Conversation({required this.id, required this.projectId, required this.name, required this.status, required this.attention, required this.updatedAt, required this.turns, this.preview = '', this.account});
  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        id: _text(json['id']), projectId: _text(json['projectId']), name: _text(json['name']), status: _text(json['status']),
        attention: json['attention'] == true, updatedAt: DateTime.tryParse(_text(json['updatedAt'])) ?? DateTime.fromMillisecondsSinceEpoch(0),
        turns: json['turns'] is int ? json['turns'] as int : 0, preview: _text(json['preview']), account: json['account'] as String?);
  /// `preview`: the line the latest answer ended on ('' while it runs or when there is none).
  final String id, projectId, name, status, preview;
  /// The project's account this conversation uses; '' when the project no longer holds it (null: the backend does not say).
  final String? account;
  final bool attention;
  final DateTime updatedAt;
  final int turns;
  bool get busy => status == 'starting' || status == 'running';
}

enum ToolStatus { running, waiting, completed, failed, denied, interrupted, unknown }

ToolStatus _toolStatus(String value) => ToolStatus.values.firstWhere((item) => item.name == value, orElse: () => ToolStatus.running);

class Tool {
  Tool({required this.id, required this.title, required this.status, required this.detail, required this.hasDetail, this.parent = '', this.outputUnreported = false});
  factory Tool.fromJson(Map<String, dynamic> json) => Tool(
        id: _text(json['id']), title: _text(json['title']), status: _toolStatus(_text(json['status'])), detail: _text(json['detail']), hasDetail: json['hasDetail'] == true,
        parent: _text(json['parent']), outputUnreported: json['outputUnreported'] == true);
  /// `parent`: the Agent call this step ran inside (empty for the turn's own steps).
  final String id, title, detail, parent;
  final ToolStatus status;
  /// `outputUnreported`: the CLI finished this step without passing its result on.
  final bool hasDetail, outputUnreported;
  bool get settled => status != ToolStatus.running && status != ToolStatus.waiting;
}

class ToolDetail {
  ToolDetail({required this.input, required this.output, this.images = const []});
  factory ToolDetail.fromJson(Map<String, dynamic> json) => ToolDetail(
        input: _map(json['input']), output: json['output'] is String ? json['output'] as String : (json['output'] == null ? '' : json['output'].toString()),
        images: _maps(json['images']).map((item) => _text(item['data'])).where((data) => data.isNotEmpty).toList());
  final Map<String, dynamic> input;
  final String output;
  /// Images the tool returned (e.g. Read of a picture), base64.
  final List<String> images;
}

class QuestionOption {
  QuestionOption(this.label, this.description);
  final String label, description;
}

class Question {
  Question({required this.question, required this.header, required this.multiSelect, required this.options});
  factory Question.fromJson(Map<String, dynamic> json) => Question(
        question: _text(json['question']), header: _text(json['header']), multiSelect: json['multiSelect'] == true,
        options: _maps(json['options']).map((item) => QuestionOption(_text(item['label']), _text(item['description']))).toList());
  final String question, header;
  final bool multiSelect;
  final List<QuestionOption> options;
}

class Permission {
  Permission({required this.id, required this.title, required this.details, required this.allow, required this.questions});
  factory Permission.fromJson(Map<String, dynamic> json) => Permission(
        id: _text(json['id']), title: _text(json['title']), details: _text(json['details']), allow: json['allow'] == true,
        questions: json['questions'] is List ? _maps(json['questions']).map(Question.fromJson).toList() : null);
  final String id, title, details;
  final bool allow;
  final List<Question>? questions;
}

/// Text and tool calls in the order they happened; `user` is a message sent mid-turn.
sealed class Block {}

class TextBlock extends Block {
  TextBlock(this.text);
  final String text;
}

class ToolBlock extends Block {
  ToolBlock(this.id);
  final String id;
}

class UserBlock extends Block {
  UserBlock(this.text, this.images);
  final String text;
  final List<String> images;
}

class Turn {
  Turn({
    required this.id, required this.prompt, required this.images, required this.status, required this.answer, required this.tools,
    required this.blocks, required this.permission, required this.error, required this.capabilities, required this.controlReady,
    required this.inherited, required this.auto, this.type = '', this.sessionId = '', this.conversationId = '', this.requestedModel = '', this.stopping = false, this.createdAt, this.finishedAt,
  });
  factory Turn.fromJson(Map<String, dynamic> json) {
    final tools = _maps(json['tools']).map(Tool.fromJson).toList();
    final answer = _text(json['answer']);
    final raw = _maps(json['blocks']);
    final blocks = raw.isNotEmpty
        ? raw.map<Block?>((item) => switch (_text(item['kind'])) {
              'text' => TextBlock(_text(item['text'])),
              'tool' => ToolBlock(_text(item['id'])),
              'user' => UserBlock(_text(item['text']), _strings(item['images'])),
              _ => null,
            }).whereType<Block>().toList()
        : <Block>[...tools.where((tool) => tool.parent.isEmpty).map((tool) => ToolBlock(tool.id)), if (answer.isNotEmpty) TextBlock(answer)];
    return Turn(
      id: _text(json['id']), prompt: _text(json['prompt']), images: _strings(json['images']), status: _text(json['status']), answer: answer,
      tools: tools, blocks: blocks, permission: json['permission'] is Map ? Permission.fromJson(_map(json['permission'])) : null,
      error: _text(json['error']), capabilities: _strings(json['capabilities']), controlReady: json['controlReady'] == true,
      inherited: json['inherited'] == true, auto: json['auto'] == true, type: _text(json['type']), sessionId: _text(json['sessionId']),
      conversationId: _text(json['conversationId']), requestedModel: _text(json['requestedModel']), stopping: json['stopping'] == true, createdAt: DateTime.tryParse(_text(json['createdAt'])), finishedAt: DateTime.tryParse(_text(json['finishedAt'])),
    );
  }
  /// `requestedModel`: the model chosen when the message was sent ('' = the account's default).
  final String id, prompt, status, answer, error, type, sessionId, conversationId, requestedModel;
  final DateTime? createdAt, finishedAt;
  final List<String> images, capabilities;
  final List<Tool> tools;
  final List<Block> blocks;
  final Permission? permission;
  final bool controlReady, inherited, auto;
  /// Cancel was asked for and the agent has not stopped yet.
  final bool stopping;
  bool get active => status == 'starting' || status == 'running';
  bool get takesMessages => controlReady && capabilities.contains('message');
  Tool? tool(String id) => tools.where((tool) => tool.id == id).firstOrNull;
  List<Tool> children(String id) => tools.where((tool) => tool.parent == id).toList();
  /// A Claude answer that finished can be forked from (the session continues in a new conversation).
  bool get forkable => type == 'claude' && status == 'done' && !inherited && sessionId.isNotEmpty;
}

/// Project uploads: images get a preview, other files show as a chip.
bool isImageUpload(String path) => RegExp(r'\.(png|jpe?g|webp|gif)$', caseSensitive: false).hasMatch(path);
String uploadName(String path) => path.split('/').last.replaceFirst(RegExp(r'^[a-f0-9]{16}[-.]'), '');

class FollowUp {
  FollowUp({required this.id, required this.text, required this.images});
  factory FollowUp.fromJson(Map<String, dynamic> json) => FollowUp(id: _text(json['id']), text: _text(json['text']), images: _strings(json['images']));
  final String id, text;
  final List<String> images;
}

/// One answer of the conversation change feed (GET conversations/:id/changes).
class TurnChanges {
  TurnChanges({required this.etag, required this.unchanged, required this.full, required this.order, required this.turns, required this.followUps, this.earlier = 0});
  factory TurnChanges.fromJson(Map<String, dynamic> json) => TurnChanges(
        etag: _text(json['etag']), unchanged: json['unchanged'] == true, full: json['full'] == true, order: _strings(json['order']),
        turns: _maps(json['turns']).map(Turn.fromJson).toList(), followUps: _maps(json['followUps']).map(FollowUp.fromJson).toList(),
        earlier: json['earlier'] is int ? json['earlier'] as int : 0);
  final String etag;
  final bool unchanged, full;
  final List<String> order;
  final List<Turn> turns;
  final List<FollowUp> followUps;
  /// Turns before the first of `order` that the feed does not follow (fetched as the user scrolls up).
  final int earlier;
}

/// Outcome of sending a message: a new turn, taken into the running turn, or queued after it.
enum Delivery { turn, message, queued }

// ── 领航 (node-app/src/lead.ts view()) ──────────────────────────────

/// One command 领航 ran in the project to check something, and what it printed.
class LeadEvidence {
  LeadEvidence(this.command, this.output);
  final String command, output;
}

/// How a card closed: `by` is `user` (answered in 领航's thread) or `elsewhere`.
class LeadResolved {
  LeadResolved({required this.answer, required this.by});
  final String answer, by;
  bool get byUser => by == 'user';
}

/// One entry of 领航's thread: `user` / `lead` / `note` (text), `did` (what it settled),
/// `seen` (a finished turn with nothing for the user) or `ask` (handed to the user).
class LeadItem {
  LeadItem({
    required this.id, required this.type, this.text = '', this.conversationId = '', this.conversation = '', this.projectId = '',
    this.action = '', this.asked = '', this.said = '', this.reason = '', this.evidence = const [], this.undo = '', this.undone = false,
    this.kind = '', this.quote, this.why = '', this.lean = '', this.options = const [], this.questions = const [], this.free = false, this.resolved,
  });
  factory LeadItem.fromJson(Map<String, dynamic> json) => LeadItem(
        id: _text(json['id']), type: _text(json['type']), text: _text(json['text']), conversationId: _text(json['conversationId']),
        conversation: _text(json['conversation']), projectId: _text(json['projectId']), action: _text(json['action']), asked: _text(json['asked']),
        said: _text(json['said']), reason: _text(json['reason']),
        evidence: _maps(json['evidence']).map((item) => LeadEvidence(_text(item['command']), _text(item['output']))).toList(),
        undo: _text(json['undo']), undone: json['undone'] == true, kind: _text(json['kind']), quote: json['quote'] is String ? json['quote'] as String : null,
        why: _text(json['why']), lean: _text(json['lean']), options: _strings(json['options']),
        questions: _maps(json['questions']).map(Question.fromJson).toList(), free: json['free'] == true,
        resolved: json['resolved'] is Map ? LeadResolved(answer: _text(_map(json['resolved'])['answer']), by: _text(_map(json['resolved'])['by'])) : null);
  final String id, type, text, conversationId, conversation, projectId;
  /// `did`: approve / answer / reply / accept / stop / start, and whether it can still be taken back (`undo` = 'stop').
  final String action, asked, said, reason, undo;
  final List<LeadEvidence> evidence;
  final bool undone;
  /// `ask`: approval / question / finished / job / failed. `quote` is null on cards written before
  /// the conversation's own words were kept apart from the question.
  final String kind, why, lean;
  final String? quote;
  final List<String> options;
  final List<Question> questions;
  /// The answer may be any text (it goes to the conversation as a message).
  final bool free;
  final LeadResolved? resolved;
  bool get canUndo => undo.isNotEmpty && !undone;
  bool get open => type == 'ask' && resolved == null;
}

/// A conversation 领航 follows that waits, runs or failed: `status` is waiting / running / failed, `note` says it in words.
class LeadWatch {
  LeadWatch({required this.id, required this.name, required this.projectId, required this.account, required this.status, required this.note, this.at});
  factory LeadWatch.fromJson(Map<String, dynamic> json) => LeadWatch(
        id: _text(json['id']), name: _text(json['name']), projectId: _text(json['projectId']), account: _text(json['account']),
        status: _text(json['status']), note: _text(json['note']), at: DateTime.tryParse(_text(json['at'])));
  final String id, name, projectId, account, status, note;
  final DateTime? at;
}

class LeadRule {
  LeadRule(this.text, {this.fixed = false});
  final String text;
  /// Also enforced in code: cannot be removed.
  final bool fixed;
}

/// 领航's state as GET lead and GET lead/changes return it.
class LeadView {
  LeadView({
    required this.configured, required this.enabled, this.model = '', this.rules = const [], this.waiting = 0, this.items = const [],
    this.watching = const [], this.rest = 0, this.working, this.draft = '', this.step = '',
  });
  factory LeadView.fromJson(Map<String, dynamic> json) => LeadView(
        configured: json['configured'] == true, enabled: json['enabled'] == true, model: _text(json['model']),
        rules: _maps(json['rules']).map((item) => LeadRule(_text(item['text']), fixed: item['fixed'] == true)).toList(),
        waiting: json['waiting'] is int ? json['waiting'] as int : 0, items: _maps(json['items']).map(LeadItem.fromJson).toList(),
        watching: _maps(json['watching']).map(LeadWatch.fromJson).toList(), rest: json['rest'] is int ? json['rest'] as int : 0,
        working: json['working'] is String ? json['working'] as String : null, draft: _text(json['draft']), step: _text(json['step']));
  /// `configured`: the backend has a system model for 领航 to judge with.
  final bool configured, enabled;
  final String model;
  final List<LeadRule> rules;
  /// Cards the user has not answered yet.
  final int waiting;
  final List<LeadItem> items;
  /// The followed conversations that wait, run or failed; `rest` counts the followed ones at rest.
  final List<LeadWatch> watching;
  final int rest;
  /// What it is looking at right now ('' for the user's words; null when idle), its answer as it is being written, and its current step.
  final String? working;
  final String draft, step;
}

List<T> parseList<T>(Object? value, T Function(Map<String, dynamic>) parse) => _maps(value).map(parse).toList();
Map<String, dynamic> asMap(Object? value) => _map(value);
