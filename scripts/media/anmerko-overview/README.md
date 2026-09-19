# anmerko overview media

These scripts reproduce the 29-second product overview and store graphics from native Skia shapes, system SF Pro fonts, and synthesized narration. The video has no background music. They require Python packages `edge-tts`, `imageio-ffmpeg`, `numpy`, `Pillow`, and `skia-python`.

```sh
export ANMERKO_MEDIA_OUTPUT=/tmp/anmerko-overview
python narrate.py
python animate.py --full --stills
python assemble.py
python render_store_art.py --output-dir /tmp/anmerko-store-art
```

The narration uses Microsoft Edge's stock Ava neural voice and requires network access. Generated intermediates stay outside the repository; only reviewed final assets are committed.

Assembly uses only the silent animation and narration clips. `score.py` retains
the earlier synthesized score for historical reproduction; it is not used by
the current assembly.

Pronounce anmerko as **ahn mare ko**. The user selected the joined TTS spelling
`ahn-mare-koh`, using `en-US-AvaMultilingualNeural` at `+5%`. `SCRIPTS` holds
canonical caption text; `SPOKEN_SCRIPTS` substitutes the pronunciation only for
synthesis, including the spoken domain. See the [developer pronunciation guide](../../../docs/development.md#brand-pronunciation)
and its selected reference clip. To replace only the opening and closing audio
while preserving existing middle clips, use `python narrate.py --segments 1 6`.
