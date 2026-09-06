/*
Copyright (C) 1996-1997 Id Software, Inc.

No C original: PORTING.md's QuakeWorld track put the WinQuake/QuakeWorld
split behind one process-wide flag (`qw.active`, src/common/quakedef.ts),
because the C keeps two source trees and builds two binaries. ARCHITECTURE.md
"Unified client and server" is what this module implements instead: one
binary whose client speaks NetQuake and QuakeWorld, with the kind of
connection -- an NQ `connect`, a QW handshake, or a demo file's header --
selecting the profile per connection rather than per process.

The model:
- `connectionProfile.client` is the client's profile (`cls.profile`, which
  reads and writes this field). It is set when a connection or a demo is
  opened and stays put until the next one.
- `connectionProfile.server` is the server's profile (`sv.profile` once the
  server-side unification lands; read-only from the client side today).
- `connectionProfile.serveronly` is QW's own `SERVERONLY` compile-time split
  between qwcl and qwsv, kept as a runtime field: it says this process has a
  server and no client, so profile questions asked without a subject resolve
  against the server rather than the client.

The connect rule, which the `connect` console command follows and
src/client/cl_main.ts implements:
- an address with an explicit `:port`, or `cl_protocol` set to `qw`, means
  QuakeWorld: the client sends `getchallenge` and runs the QW handshake.
- anything else is NetQuake: the client opens a NET_Connect and runs the
  NetQuake connect sequence.
- `playdemo`/`timedemo` take the profile from the file: `.qwd` is
  QuakeWorld, `.dem` (any protocol) is NetQuake.
- `-qw` on the command line sets the boot profile to QuakeWorld, which is
  what the `qwcl` entry point passes and what an address with no port then
  inherits.

`qw.active` (src/common/quakedef.ts) stays as a compatibility getter over
this state for the ~435 sites that read it, and its setter writes both
profiles at once so the existing entry points and suites that assign it keep
their exact meaning.
*/

export type NetProfileT = "nq" | "qw";

export const connectionProfile: {
  client: NetProfileT;
  server: NetProfileT;
  serveronly: boolean;
  // The profile the client falls back to when no connection is open: "qw"
  // for a `-qw` boot (what `qwcl` passes), "nq" otherwise. A disconnect
  // returns the client to it, so an `-qw` client stays QuakeWorld across
  // connections exactly as the separate qwcl binary did, while the default
  // boot goes back to letting the connect rule decide.
  boot: NetProfileT;
} = {
  client: "nq",
  server: "nq",
  serveronly: false,
  boot: "nq",
};

export function setBootProfile(profile: NetProfileT): void {
  connectionProfile.boot = profile;
  connectionProfile.client = profile;
}

export function bootProfile(): NetProfileT {
  return connectionProfile.boot;
}

// Called when a connection or a demo closes: the client goes back to the boot
// profile until the next `connect`/`playdemo` names one.
export function resetClientProfile(): void {
  connectionProfile.client = connectionProfile.boot;
}

// The `connect` rule (see the file header): an address carrying an explicit
// port, or `cl_protocol` naming QuakeWorld, means the QuakeWorld handshake;
// anything else is NetQuake. `protocol` is the raw `cl_protocol` string.
export function connectProfileFor(address: string, protocol: string): NetProfileT {
  const wanted = protocol.trim().toLowerCase();
  if (wanted === "qw" || wanted === "quakeworld" || wanted === "28" || wanted === "29") return "qw";
  if (wanted === "nq" || wanted === "netquake" || wanted === "15" || wanted === "666" || wanted === "999") return "nq";
  return addressHasPort(address) ? "qw" : "nq";
}

// "1.2.3.4:27500" / "host.example:27500" / "[::1]:27500" carry a port;
// "1.2.3.4", "host.example" and a bare "[::1]" do not.
export function addressHasPort(address: string): boolean {
  const s = address.trim();
  if (s === "") return false;
  const closing = s.lastIndexOf("]");
  const colon = s.lastIndexOf(":");
  if (colon < 0 || colon < closing) return false;
  // an unbracketed IPv6 literal has several colons and no port
  if (closing < 0 && s.indexOf(":") !== colon) return false;
  const port = s.slice(colon + 1);
  if (port === "") return false;
  for (let i = 0; i < port.length; i++) {
    const c = port.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

export function clientProfile(): NetProfileT {
  return connectionProfile.client;
}

export function setClientProfile(profile: NetProfileT): void {
  connectionProfile.client = profile;
}

export function serverProfile(): NetProfileT {
  return connectionProfile.server;
}

export function setServerProfile(profile: NetProfileT): void {
  connectionProfile.server = profile;
}

// The profile a question with no subject resolves against: the client's,
// unless this process is a server with no client of its own (qwsv).
export function activeProfile(): NetProfileT {
  return connectionProfile.serveronly ? connectionProfile.server : connectionProfile.client;
}

// What `qw.active` returns.
export function qwActive(): boolean {
  return activeProfile() === "qw";
}

// What `qw.active = x` does: both sides move together, which is what the
// qwcl and qwsv entry points (and every suite that sets the flag) mean by it.
export function setProcessProfile(profile: NetProfileT): void {
  connectionProfile.client = profile;
  connectionProfile.server = profile;
}
