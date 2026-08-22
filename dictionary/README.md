# dictionary — Pose Keypoint Clips

**The choreography for each sign.** One JSON file per sign, containing the
keypoint positions the Three.js avatar in the browser extension replays.

This is different from the English → gloss lookup that lives in
`backend/functions/text-to-gloss/dictionaries/`. That maps words to gloss
labels ("hello" → `HELLO`). This directory maps gloss labels to the
actual body motion the avatar performs.

## Full lookup chain

```
spoken word "hello"
        │
        ▼   (backend/functions/text-to-gloss/dictionaries/asl.json)
gloss label  HELLO
        │
        ▼   (backend/functions/text-to-gloss/mapper.py)
sign ID      asl-hello-v1
        │
        ▼   (this directory — asl/hello-v1.json)
pose keypoint clip  (frames of joint positions)
        │
        ▼   (extension/src/content/avatar.ts, Three.js)
avatar performs the sign
```

## Layout

```
dictionary/
├── README.md          (this file)
├── asl/
│   ├── hello-v1.json
│   ├── thank-you-v1.json
│   └── …
├── bsl/
│   └── …
└── ghsl/
    └── …
```

Filenames use the `<gloss-slug>-v<n>.json` convention — the same slug the
sign ID uses. Versioning lets a sign's animation be improved without
invalidating older cached clips.

## Clip file format

```jsonc
{
  "schemaVersion": 1,
  "signId": "asl-hello-v1",
  "gloss": "HELLO",
  "language": "ASL",
  "durationMs": 500,     // total playback duration
  "fps": 30,             // capture rate
  "joints": [            // ordered joint names, index maps to positions
    "left_shoulder", "left_elbow", "left_wrist",
    "right_shoulder", "right_elbow", "right_wrist",
    "head"
  ],
  "frames": [            // one entry per captured frame
    {
      "t": 0,            // ms from start
      "positions": [     // one 3D coordinate per joint, in the same order as joints
        [0.0, 1.4, 0.0],
        [0.15, 1.2, 0.05],
        …
      ]
    },
    …
  ]
}
```

Coordinates are in a body-relative frame: origin at the hip midpoint,
Y-up (metres), X-right, Z-forward.

## Where they live in production

Clips are packaged into an S3 bucket and served through CloudFront near
the client. The `avatar-rendering` service (Python) is only involved in
the stretch-goal generative path; the core one-way pipeline is a static
CDN lookup:

```
sign ID  →  https://<cdn>/asl/hello-v1.json  →  play in Three.js
```

## How to add a sign

1. Record or generate the keypoint frames (see the pose-generator
   stretch goal for the offline approach).
2. Save as `dictionary/<lang>/<gloss-slug>-v1.json` following the format
   above.
3. Add the English → gloss mapping in
   `backend/functions/text-to-gloss/dictionaries/<lang>.json` so the
   Lambda knows to emit the matching sign ID.
4. Upload to S3 and invalidate the CloudFront cache prefix for the file.

Version numbers are bumped only when a specific sign's animation changes
in a way that would look wrong if a client played the old cached clip.

## Status

**Currently empty apart from one starter clip per language** to keep the
avatar loader wired end to end. Real content production (recording a
signer, processing to keypoints) is the largest remaining work item in
the project.
