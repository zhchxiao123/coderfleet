// Attachments of a message being written, shared by the conversation's composer
// and 领航's: picked (camera, photos, any file), each uploaded as soon as it is
// picked, shown in a row above the text with a way to drop it.
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
// flutter_markdown_plus builds on this library; one Material keeps one theme.
// ignore: deprecated_member_use
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../models.dart';
import 'theme.dart';
import 'turn_view.dart';

enum AttachFrom { camera, photos, files }

/// A picked file. It is read when it is uploaded, so a large one never sits in memory;
/// `preview` holds the bytes of an image small enough to show.
typedef PickedFile = ({String name, int size, Stream<List<int>> Function() open, Uint8List? preview});

/// A picked file already in memory.
PickedFile pickedBytes(String name, Uint8List bytes) => (name: name, size: bytes.length, open: () => Stream.value(bytes), preview: bytes);

/// Picks attachments; tests replace it.
typedef AttachmentSource = Future<List<PickedFile>> Function(BuildContext context, AttachFrom from);

Future<List<PickedFile>> pickAttachments(BuildContext context, AttachFrom from) async {
  if (from == AttachFrom.files) {
    final files = await FilePicker.pickFiles();
    return [
      for (final file in files.map((item) => item.xFile))
        await () async {
          final size = await file.length();
          return (name: file.name, size: size, open: () => file.openRead().cast<List<int>>(),
              preview: isImageUpload(file.name) && size <= maxPreview ? await file.readAsBytes() : null);
        }(),
    ];
  }
  final picker = ImagePicker();
  final files = from == AttachFrom.camera
      ? [?await picker.pickImage(source: ImageSource.camera, maxWidth: 2048, maxHeight: 2048, imageQuality: 85)]
      : await picker.pickMultiImage(maxWidth: 2048, maxHeight: 2048, imageQuality: 85, limit: 10);
  return [for (final file in files) pickedBytes(file.name, await file.readAsBytes())];
}

/// The backend's limit for one upload.
const maxUpload = 500 * 1024 * 1024;
/// The largest image shown as a picture; a larger one shows as a file.
const maxPreview = 20 * 1024 * 1024;
/// Attachments one message can carry.
const maxAttachments = 20;

class Attachment {
  Attachment(this.name, this.size, this.preview);
  final String name;
  final int size;
  final Uint8List? preview;
  /// Where the backend keeps it, once uploaded.
  String? path;
  bool get image => preview != null && isImageUpload(name);
}

/// The attachments of the message being written. [upload] sends one file to where the message
/// goes (a project, or 领航) and answers with its path; [cache] gets the bytes of an uploaded image.
class Attachments extends ChangeNotifier {
  Attachments({required this.upload, this.cache});
  final Future<String> Function(String name, Stream<List<int>> data, int size) upload;
  final UploadCache? cache;
  final List<Attachment> items = [];
  bool _disposed = false;

  bool get isEmpty => items.isEmpty;
  bool get uploading => items.any((item) => item.path == null);
  List<String> get paths => [for (final item in items) ?item.path];

  /// Picks files from [from] and starts uploading each; a problem is shown on [context].
  Future<void> add(BuildContext context, AttachFrom from, AttachmentSource source) async {
    List<PickedFile> picked;
    try { picked = await source(context, from); } catch (error) { if (context.mounted) showMessage(context, '没能读取文件：$error'); return; }
    for (final file in picked.take(maxAttachments - items.length)) {
      if (file.size > maxUpload) { if (context.mounted) showMessage(context, '${file.name} 超过 500 MB'); continue; }
      final name = from == AttachFrom.files || file.name.contains('.') ? file.name : '${file.name}.jpg';
      final item = Attachment(name, file.size, file.preview);
      items.add(item);
      _changed();
      upload(name, file.open(), file.size).then((path) {
        if (item.image) cache?.seed(path, item.preview!);
        item.path = path;
        if (items.contains(item)) _changed();
      }).catchError((Object error) {
        if (_disposed || !items.remove(item)) return;
        _changed();
        if (context.mounted) showMessage(context, '上传失败：$error');
      });
    }
  }

  void remove(Attachment item) {
    items.remove(item);
    _changed();
  }

  void clear() {
    items.clear();
    _changed();
  }

  /// An upload may finish after the page that started it closed: nobody is told then.
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Where to attach from: camera, photos or files.
void showAttachMenu(BuildContext context, void Function(AttachFrom from) pick) => showModalBottomSheet<void>(context: context, builder: (sheet) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('拍照'), onTap: () { Navigator.pop(sheet); pick(AttachFrom.camera); }),
      ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('从相册选择'), onTap: () { Navigator.pop(sheet); pick(AttachFrom.photos); }),
      ListTile(leading: const Icon(Icons.insert_drive_file_outlined), title: const Text('选择文件'), onTap: () { Navigator.pop(sheet); pick(AttachFrom.files); }),
    ])));

/// The picked attachments above the text: dimmed with a spinner while uploading, each with a button that drops it.
class AttachmentRow extends StatelessWidget {
  const AttachmentRow({super.key, required this.attachments});
  final Attachments attachments;
  @override
  Widget build(BuildContext context) => SizedBox(height: 68, child: ListView(scrollDirection: Axis.horizontal, children: [
        for (final item in attachments.items)
          Padding(padding: const EdgeInsets.only(right: 8, bottom: 8), child: Stack(children: [
            item.image
                ? ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.memory(item.preview!, width: 60, height: 60, fit: BoxFit.cover,
                    opacity: AlwaysStoppedAnimation(item.path == null ? 0.45 : 1)))
                : Opacity(opacity: item.path == null ? 0.45 : 1, child: FileChip(name: item.name, size: item.size, height: 60, maxWidth: 200)),
            if (item.path == null) const Positioned.fill(child: Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)))),
            Positioned(top: 2, right: 2, child: GestureDetector(
              onTap: () => attachments.remove(item),
              child: Container(width: 20, height: 20, decoration: const BoxDecoration(color: Color(0xB80F1115), shape: BoxShape.circle),
                  child: const Icon(Icons.close, size: 12, color: Colors.white)),
            )),
          ])),
      ]));
}
