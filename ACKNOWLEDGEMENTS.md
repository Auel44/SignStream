# Acknowledgements and third-party licences

SignStream is built on work that other people released for others to use. This
file records each piece **in the form its licence asks for**, not as a courtesy
list. Where a licence imposes a condition on this project, that condition is
stated plainly rather than summarised away.

Two obligations here are binding and easy to miss:

- **The ASL dictionary may not be used commercially.** It derives from WLASL,
  which is released under the Computational Use of Data Agreement — academic
  and computational use only. See [Sign language data](#sign-language-data).
- **The GhSL dictionary requires attribution wherever it is distributed**, under
  CC BY 4.0, including a statement that it was modified. It was: the keypoints
  were re-normalised and trimmed.

---

## Sign language data

### Ghanaian Sign Language Lexicon

The GhSL word dictionary — 1,198 signs — is derived entirely from this dataset.

> **Ghanaian Sign Language Lexicon** by Fragkiadakis, M., Nyst, V. A. S. &
> Nyarko, M. (2021). Zenodo. <https://zenodo.org/records/4533753>
> Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
> **Modified**: OpenPose keypoints were re-normalised to a neck-centred, Y-up,
> shoulder-width-0.4 m frame, and leading/trailing dead air was trimmed.

Recorded by Marco Nyarko, a Ghanaian Sign Language instructor at the University
of Ghana, with support from Leiden University's HANDS! Lab. The signs in this
project exist because one signer sat down and performed 1,200 of them.

CC BY 4.0 permits commercial use. The attribution above, the licence link, and
the note that the material was modified must travel with any redistribution.

### WLASL — Word-Level American Sign Language

The ASL word dictionary — 1,981 signs — is derived from WLASL.

> Li, D., Rodriguez, C., Yu, X. & Li, H. (2020). *Word-level Deep Sign Language
> Recognition from Video: A New Large-scale Dataset and Methods Comparison.*
> IEEE Winter Conference on Applications of Computer Vision, 1459–1469.
> <https://github.com/dxli94/WLASL>

**Licence: Computational Use of Data Agreement (C-UDA) — academic and
computational use only. Commercial use is not permitted.**

This is a real constraint on the project, not a formality. SignStream's ASL
mode cannot be commercialised while its dictionary comes from WLASL. GhSL is
unaffected, so the Ghana-facing deliverable — the one this project is actually
for — is clear. Replacing the ASL clips with a permissively licensed source
would be required before any commercial ASL release.

### The manual alphabet

The GhSL letter clips are copies of the ASL letter clips, and inherit WLASL's
terms. This is linguistics rather than convenience: deaf education in Ghana
began in 1957 under Andrew Foster, who brought ASL with him, and GhSL's manual
alphabet is the ASL one — one-handed, 22 distinct handshapes across 26 letters.
Each copied clip records `derivedFrom` and `derivedNote` in its own JSON so the
provenance cannot be lost. See `pose-generator/src/copy_alphabet.py`.

---

## Avatars

All twelve avatars are by **[Polygonal Mind](https://www.polygonalmind.com)**,
released as part of the [100 Avatars](https://github.com/PolygonalMind/100Avatars)
project under **CC0 1.0** (public domain dedication).

`Aurora` · `Cool Alien` · `Cool Banana` · `Crimsom` · `101_EGG BOY` · `Erika` ·
`Ferk` · `Horror Nurse` · `Jennifer` · `Pumpkin` · `Skull` · `Zombie`

CC0 waives all rights and requires no attribution. They are credited anyway,
because a public-domain dedication is a gift and the project would have shipped
without an avatar otherwise. Each file's own `VRM.meta` block carries the same
author and licence, so the credit survives even if this file does not.

---

## Software

### Runtime — shipped inside the extension

| Component | Licence | Used for |
| --- | --- | --- |
| [three.js](https://threejs.org) | MIT | Rendering and posing the avatar |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | MIT | Loading VRM humanoids and their normalized bones |
| [React](https://react.dev) | MIT | Popup and settings UI |

The MIT licence requires its copyright notice and permission notice to be
included in distributions. These libraries are bundled into `extension/dist`,
so that build **must** ship their notices — see [Redistribution](#redistribution).

### Backend and tooling

| Component | Licence | Used for |
| --- | --- | --- |
| [Moonshine ONNX](https://github.com/usefulsensors/moonshine) (Useful Sensors) | MIT | Speech recognition. Chosen over Whisper for CPU latency |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) (Google) | Apache-2.0 | Pose extraction in `pose-generator` |
| [OpenPose](https://github.com/CMU-Perceptual-Computing-Lab/openpose) (CMU) | Non-commercial academic licence | Format of the source keypoints (not run here) |
| [Vite](https://vite.dev) · [TypeScript](https://www.typescriptlang.org) · [Tailwind CSS](https://tailwindcss.com) · [esbuild](https://esbuild.github.io) | MIT / Apache-2.0 | Build tooling (not shipped) |
| [boto3](https://github.com/boto/boto3) · [NumPy](https://numpy.org) | Apache-2.0 / BSD-3-Clause | Lambda runtime |

### Evaluated during avatar authoring

[MMS-Player](https://github.com/DFKI-SignLanguage/MMS-Player) (DFKI, GPL-3.0) and
[MakeHuman](http://www.makehumancommunity.org) (assets CC0) were used offline while
exploring how to produce a rigged avatar. **Neither contributed anything to the
shipped build** — the twelve avatars are Polygonal Mind's CC0 VRM models, loaded
directly. That pipeline was retired and its working copies removed from this
repository, so no GPL-3.0 code is present in or distributed with SignStream.

### Considered and not used

- **AVASAG** — German Sign Language corpus, CC BY-NC-ND. The "no derivatives"
  term makes derived clips undistributable, so nothing from it is in this repo.
- **AfriSign** — CC BY-NC-ND and built from JW.org video. Not used, for the
  same reason.
- **Whisper** (OpenAI) — evaluated and rejected on CPU latency, not licensing.

---

## Redistribution

If this extension is published — Chrome Web Store, a release archive, or a
handed-in build — the following must go with it:

1. **This file**, or an equivalent notice carrying the same content.
2. **MIT notices** for three.js, three-vrm and React, since their code is
   inside `extension/dist`.
3. **The CC BY 4.0 attribution** for the GhSL lexicon, including the statement
   that it was modified.
4. **No commercial distribution of the ASL dictionary**, per C-UDA.

The clips served from S3/CloudFront are derived data and carry the same terms
as their sources; the CDN being public does not relicense them.

---

## A note on the data

Both dictionaries exist because Deaf communities and the researchers working
with them chose to make their languages machine-readable in public. The GhSL
lexicon in particular is, as far as this project could establish, **the only
public word-level GhSL keypoint dataset that exists** — 1,200 signs from one
signer. Low-resource sign languages are low-resource because that work is rare
and unfunded, not because the languages are simple.
