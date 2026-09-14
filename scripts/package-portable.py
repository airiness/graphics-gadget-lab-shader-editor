"""Build a portable release from pinned, prebuilt inputs. Never overwrite a release."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--main', required=True, type=Path)
    parser.add_argument('--editor', required=True, type=Path)
    parser.add_argument('--webview', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    main, editor, destination = args.main.resolve(), args.editor.resolve(), args.destination.resolve()
    if destination.exists():
        raise RuntimeError('Destination already exists; use a fresh release directory')
    def git(root, *command):
        return subprocess.check_output(['git', '-c', f'safe.directory={root.as_posix()}', '-C', str(root), *command], text=True).strip()
    pin = json.loads((editor/'tests/environment-producer-baseline.json').read_text())
    if git(main, 'rev-parse', 'HEAD') != pin['producerRevision']:
        raise RuntimeError('Main checkout does not match the pinned release producer')
    for repository in (main, editor):
        if git(repository, 'status', '--porcelain', '--untracked-files=no'):
            raise RuntimeError(f'Commit tracked changes before packaging: {repository}')
    source = main/'Scripts/Environment/publish_environment.py'
    spec = importlib.util.spec_from_file_location('publisher', source)
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)
    destination.mkdir(parents=True)
    publication = publisher.publish(main, main/'Build/Output/x64/Release', destination/'Environment')
    publisher.init_state(destination/'Environment', destination/'State')
    shutil.copy2(editor/'apps/editor/src-tauri/target/release/gglab-shader-graph-editor.exe', destination/'ShaderEditor.exe')
    publisher.bundle_crt(destination)
    shutil.copytree(args.webview, destination/'WebView2')
    (destination/'portable.json').write_text('{"portableVersion":1}\n', encoding='utf-8')
    examples = destination/'Examples'
    examples.mkdir()
    for graph in (main/'Shaders').rglob('*.shadergraph'):
        target = examples/graph.relative_to(main/'Shaders')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(graph, target)
    for name in ('surface-texture-preview.shadergraph', 'surface-neon-reactor-preview.shadergraph', 'surface-color-study-preview.shadergraph'):
        shutil.copyfile(editor/'packages/shader-graph-core/tests/fixtures'/name, examples/name)
    notices = destination/'ThirdPartyNotices'
    notices.mkdir()
    for package in (main/'packages').iterdir():
        for path in package.rglob('*'):
            if path.is_file() and ('license' in path.name.lower() or 'licence' in path.name.lower() or 'notice' in path.name.lower()) and path.suffix.lower() in ('.txt','.md','.rtf',''):
                target = notices/package.name/path.relative_to(package)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path,target)
    for name in ('assimp','imgui','spdlog','entt','nlohmann-json','DirectXTex','DirectXMesh','VulkanMemoryAllocator','D3D12MemoryAllocator'):
        folder=main/'Externals/Vender'/name
        for path in folder.glob('*'):
            if path.is_file() and ('license' in path.name.lower() or 'copying' in path.name.lower()):
                target=notices/name/path.name
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(path,target)
    js_notices = {}
    for pattern in ('*/node_modules/*/LICENSE*', '*/node_modules/@*/*/LICENSE*'):
        for path in (editor/'node_modules/.pnpm').glob(pattern):
            if path.is_file():
                relative = path.relative_to(editor/'node_modules/.pnpm').as_posix()
                filename = hashlib.sha256(relative.encode()).hexdigest() + '.txt'
                js_notices[filename] = relative
                target=notices/'JavaScript'/filename
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(path,target)
    (notices/'javascript-sources.json').write_text(json.dumps(js_notices, indent=2)+'\n', encoding='utf-8')
    (destination/'README.txt').write_text('''GGLab Shader Graph Editor - portable final release

Extract the entire ZIP into a short, writable local Windows x64 directory,
for example D:\\GGLabEditor. Do not run inside the ZIP. Compatible DX12 and
Vulkan 1.3 GPU drivers are required. Development tools and Internet are not.

Run ShaderEditor.exe. Open GGLab Environment... and select Use bundled
Environment. Wait for final-location compilation and native Preview proof.
Choose the Examples folder as a workspace, or open/create a shader graph.
Build and Preview then use the frozen, bundled gglab toolchain and runtime.

Environment is immutable. State holds writable shader artifacts, caches and
logs; UserData holds desktop settings and WebView2 data. Keep your graphs.
The release includes a clean initialized State; it contains no prior readiness
or registration. Do not replace State in a package you have already used.
Moving the entire directory requires Use bundled Environment again. Close
Editor and Preview before moving. Existing user data is never migrated or
deleted automatically. State paths over 90 UTF-16 units are unsupported.

This is a frozen, unmaintained tool. Its gglab version is independent of later
gglab development. See release-manifest.json for exact inputs and hashes.
WebView2 Fixed Runtime 152.0.4191.62 x64 comes from Microsoft. Upstream runtime
license and credits remain in WebView2. Additional notices are in
ThirdPartyNotices and Environment/payload/Licenses and Assets.
''',encoding='utf-8')
    manifest={'releaseVersion':1,'status':'frozen-release','gglabRevision':git(main,'rev-parse','HEAD'), 'editorRevision':git(editor,'rev-parse','HEAD'), 'editorDirty':bool(git(editor,'status','--porcelain','--untracked-files=no')), 'environmentId':publication['environmentId'],'webviewVersion':'152.0.4191.62','files':[]}
    for path in sorted(destination.rglob('*')):
        if path.is_file():
            manifest['files'].append({'path':path.relative_to(destination).as_posix(),'size':path.stat().st_size,'sha256':sha(path)})
    (destination/'release-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'destination':str(destination),'files':len(manifest['files']),'environmentId':publication['environmentId']}))

if __name__=='__main__': main()
