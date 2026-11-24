// Shapes of the CoderFleet Node backend's chat API (node-app/src/server.ts).
// Parsing is lenient: unknown or missing fields fall back to empty values.

Map<String, dynamic> _map(Object? value) => value is Map ? value.cast<String, dynamic>() : const {};
List<Map<String, dynamic>> _maps(Object? value) => value is List ? value.whereType<Map>().map((item) => item.cast<String, dynamic>()).toList() : const [];
String _text(Object? value) => value is String ? value : '';
List<String> _strings(Object? value) => value is List ? value.whereType<String>().toList() : const [];

class Project {
  Project({required this.id, required this.name, required this.type, required this.typeLabel, required this.state, required this.chat, required this.active});
  factory Project.fromJson(Map<String, dynamic> json) => Project(
        id: _text(json['id']), name: _text(json['name']), type: _text(json['type']), typeLabel: _text(json['typeLabel']),
        state: _text(json['state']), chat: json['chat'] == true, active: json['active'] != false);
  final String id, name, type, typeLabel, state;
  final bool chat, active;
  bool get running => state == 'running';
  bool get canChat => chat && active;
}

class ModelOption {
  ModelOption(this.id, this.label);
  final String id, label;
}

class Conversation {
  Conversation({required this.id, required this.projectId, required this.name, required this.status, required this.attention, required this.updatedAt, required this.turns});
  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        id: _text(json['id']), projectId: _text(json['projectId']), name: _text(json['name']), status: _text(json['status']),
        attention: json['attention'] == true, updatedAt: DateTime.tryParse(_text(json['updatedAt'])) ?? DateTime.fromMillisecondsSinceEpoch(0),
        turns: json['turns'] is int ? json['turns'] as int : 0);
  final String id, projectId, name, status;
  final bool attention;
  final DateTime updatedAt;
  final int turns;
  bool get busy => status == 'starting' || status == 'running';
}

enum ToolStatus { running, waiting, completed, failed, denied, interrupted, unknown }

ToolStatus _toolStatus(String value) => ToolStatus.values.firstWhere((item) => item.name == value, orElse: () => ToolStatus.running);

class Tool {
  Tool({required this.id, required this.title, required this.status, required this.detail, required this.hasDetail, this.parent = ''});
  factory Tool.fromJson(Map<String, dynamic> json) => Tool(
        id: _text(json['id']), title: _text(json['title']), status: _toolStatus(_text(json['status'])), detail: _text(json['detail']), hasDetail: json['hasDetail'] == true,
        parent: _text(json['parent']));
  /// `parent`: the Agent call this step ran inside (empty for the turn's own steps).
  final String id, title, detail, parent;
  final ToolStatus status;
  final bool hasDetail;
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
    required this.inherited, required this.auto, this.type = '', this.sessionId = '', this.conversationId = '', this.stopping = false, this.createdAt, this.finishedAt,
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
      conversationId: _text(json['conversationId']), stopping: json['stopping'] == true, createdAt: DateTime.tryParse(_text(json['createdAt'])), finishedAt: DateTime.tryParse(_text(json['finishedAt'])),
    );
  }
  final String id, prompt, status, answer, error, type, sessionId, conversationId;
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
  TurnChanges({required this.etag, required this.unchanged, required this.full, required this.order, required this.turns, required this.followUps});
  factory TurnChanges.fromJson(Map<String, dynamic> json) => TurnChanges(
        etag: _text(json['etag']), unchanged: json['unchanged'] == true, full: json['full'] == true, order: _strings(json['order']),
        turns: _maps(json['turns']).map(Turn.fromJson).toList(), followUps: _maps(json['followUps']).map(FollowUp.fromJson).toList());
  final String etag;
  final bool unchanged, full;
  final List<String> order;
  final List<Turn> turns;
  final List<FollowUp> followUps;
}

/// Outcome of sending a message: a new turn, taken into the running turn, or queued after it.
enum Delivery { turn, message, queued }

List<T> parseList<T>(Object? value, T Function(Map<String, dynamic>) parse) => _maps(value).map(parse).toList();
Map<String, dynamic> asMap(Object? value) => _map(value);
