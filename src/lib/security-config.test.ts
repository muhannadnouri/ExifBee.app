import { describe, expect, it } from 'vitest';
import buildRs from '../../src-tauri/build.rs?raw';
import cargoToml from '../../src-tauri/Cargo.toml?raw';
import libRs from '../../src-tauri/src/lib.rs?raw';
import tauriConfRaw from '../../src-tauri/tauri.conf.json?raw';
import { COMMAND_NAMES } from './ipc';

const capabilities = import.meta.glob<string>('../../src-tauri/capabilities/*', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const tauriConf = JSON.parse(tauriConfRaw) as {
  app: {
    withGlobalTauri?: boolean;
    security: { csp: string; assetProtocol?: { enable?: boolean } };
  };
};
const kebab = (name: string) => name.replaceAll('_', '-');
const sorted = (values: string[]) => [...values].sort();

// @req SEC-008
describe('renderer permissions (least privilege)', () => {
  it('declares the same commands in build.rs, generate_handler!, the capability and ipc.ts', () => {
    const manifest = [
      ...(/COMMANDS[^=]*=\s*&\[([^\]]*)\]/.exec(buildRs)?.[1] ?? '').matchAll(/"(\w+)"/g),
    ].map((match) => match[1] ?? '');
    const handler = [
      ...(/generate_handler!\[([^\]]*)\]/.exec(libRs)?.[1] ?? '').matchAll(/commands::(\w+)/g),
    ].map((match) => match[1] ?? '');
    expect(manifest.length).toBe(9);
    expect(sorted(manifest)).toEqual(sorted(handler));
    expect(sorted(manifest)).toEqual(sorted(COMMAND_NAMES));

    const files = Object.entries(capabilities);
    expect(files.map(([path]) => path.split('/').pop())).toEqual(['main.json']);
    const capability = JSON.parse(files[0]?.[1] ?? '{}') as {
      windows: string[];
      permissions: string[];
      remote?: unknown;
    };
    expect(capability.windows).toEqual(['main']);
    expect(capability.remote).toBeUndefined();
    // Only ExifBee's own commands plus listening for events (the files-dropped and scan-progress results, DEC-020/DEC-021):
    // no other core:, fs:, shell:, dialog: or plugin permissions, not even emitting events.
    expect(sorted(capability.permissions)).toEqual(
      sorted([
        ...manifest.map((name) => `allow-${kebab(name)}`),
        'core:event:allow-listen',
        'core:event:allow-unlisten',
      ]),
    );
  });

  it('registers no plugin the renderer could use for shell, filesystem or network access', () => {
    expect([...libRs.matchAll(/\.plugin\(([^)]*\))\)/g)].map((match) => match[1])).toEqual([
      'tauri_plugin_dialog::init()',
    ]);
    for (const plugin of ['shell', 'fs', 'http', 'opener', 'process', 'websocket', 'upload']) {
      expect(cargoToml).not.toMatch(new RegExp(`^tauri-plugin-${plugin}\\s*=`, 'm'));
    }
    expect(tauriConf.app.withGlobalTauri ?? false).toBe(false);
    expect(tauriConf.app.security.assetProtocol?.enable ?? false).toBe(false);
  });
});

// @req SEC-001, SEC-003
describe('content security policy', () => {
  const directives = new Map(
    tauriConf.app.security.csp
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name = '', ...sources]) => [name, sources]),
  );

  it('allows only local app assets and Tauri IPC', () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('connect-src')).toEqual(['ipc:', 'http://ipc.localhost']);
  });

  it('never permits inline/eval code or any remote origin', () => {
    for (const [name, sources] of directives) {
      for (const source of sources) {
        expect(source, name).not.toMatch(
          /unsafe|^\*$|^data:|^blob:|^https?:\/\/(?!ipc\.localhost$)/,
        );
      }
    }
  });
});
