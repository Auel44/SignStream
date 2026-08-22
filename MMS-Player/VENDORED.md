# MMS-Player — vendored third-party component

This directory is **not** SignStream code. It is a copy of DFKI's MMS-Player,
the open-source sign-language avatar animation system used offline to produce
the rigged avatars in `extension/public/`. Nothing here runs at extension
runtime.

| | |
| --- | --- |
| Upstream | https://github.com/DFKI-SignLanguage/MMS-Player |
| Commit | `3c2db127b9a384620b8974576a90ad0a8b663f5d` (2026-05-27) |
| Licence | **GPL-3.0** — see [LICENSE.txt](LICENSE.txt) |
| Paper | https://arxiv.org/abs/2507.16463 |

## Modifications

Per GPL-3.0 §5(a), the change made to the upstream sources is recorded here.

**`main.py`, modified 2026-08-10 — asset paths anchored to `__file__`.**

Upstream loads its assets through relative paths (`./assets/defaults.blend`).
Blender resolves relative paths in `bpy.data.libraries.load()` against the open
`.blend` file rather than the working directory, and in `--background` mode
there is no open file — so the path collapsed to the drive root
(`C:ssets\defaults.blend`) and every run failed. The fix resolves the assets
directory from the module's own location instead, which is correct regardless
of where the command is invoked from:

```python
_ASSETS = Path(__file__).resolve().parent / "assets"
```

Three call sites were updated to use it: the two `Glue(...)` constructions and
the `controller_config.json` load. There are no other changes.

## Licence note

GPL-3.0 is copyleft. This directory is redistributed under GPL-3.0 with its
licence text intact and the modification above disclosed. It is an *aggregate*
alongside SignStream rather than a derivative of it: the extension neither
links to nor invokes this code — MMS-Player is an authoring tool that ran once
to produce `.glb` files. If this project is ever distributed as a single
licensed work, that distinction should be reviewed properly rather than assumed.

## Re-creating this directory from upstream

```bash
git clone https://github.com/DFKI-SignLanguage/MMS-Player.git
cd MMS-Player && git checkout 3c2db127b9a384620b8974576a90ad0a8b663f5d
# then re-apply the main.py change described above
```
