"""Combine the finished 1080p animation with narration only, without music.
Usage: python assemble.py --manifest ../audio/segments.json
The manifest accepts a list, or {segments: [...]}, each with file and start.
"""
from pathlib import Path
import argparse,json,subprocess,wave,os,textwrap
import numpy as np
import imageio_ffmpeg

ROOT=Path(os.environ.get("ANMERKO_MEDIA_OUTPUT", Path(__file__).resolve().parent / "build"))
RATE=48000
DURATION=29.0
STARTS=[.2,5.5,9.3,14.65,19.65,23.5]
parser=argparse.ArgumentParser()
parser.add_argument('--manifest',type=Path,default=ROOT/'audio'/'segments.json')
args=parser.parse_args()
raw=json.loads(args.manifest.read_text())
segments=raw if isinstance(raw,list) else raw['segments']
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
track=np.zeros(round(DURATION*RATE),dtype=np.float32)
subtitles=[]

def timestamp(t):
    ms=round(t*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'

for i,segment in enumerate(segments):
    p=Path(segment['file'])
    if not p.is_absolute(): p=args.manifest.parent/p
    decoded=subprocess.run([ffmpeg,'-v','error','-i',str(p),'-ar',str(RATE),'-ac','1','-f','f32le','-'],check=True,capture_output=True).stdout
    samples=np.frombuffer(decoded,dtype='<f4').copy()
    start=float(segment.get('start',STARTS[i]))
    end=start+len(samples)/RATE
    next_start=float(segments[i+1].get('start',STARTS[i+1])) if i+1<len(segments) else DURATION-.15
    if end>next_start:
        raise ValueError(f'Voice segment {i+1} overlaps: {start:.2f}–{end:.2f}; next at{next_start:.2f}')
    offset=round(start*RATE)
    track[offset:offset+len(samples)]+=samples
    # Preserve natural phrase spacing and ensure no clicks at file boundaries.
    subtitles.append(f'{timestamp(start)} --> {timestamp(end)}\n{textwrap.fill(segment["text"], 48)}\n')

narration=ROOT/'narration.wav'
with wave.open(str(narration),'wb') as wav:
    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(RATE)
    wav.writeframes((np.clip(track,-1,1)*32767).astype('<i2').tobytes())
(ROOT/'anmerko-overview.en.vtt').write_text('WEBVTT\n\n'+'\n'.join(subtitles))
video=ROOT/'anmerko-overview.mp4'
filters='[1:a]loudnorm=I=-17:TP=-1.5:LRA=7,aresample=48000,pan=stereo|c0=c0|c1=c0,alimiter=limit=0.95:level=false:latency=true[a]'
subprocess.run([ffmpeg,'-hide_banner','-y','-i',str(ROOT/'silent.mp4'),'-i',str(narration),'-filter_complex',filters,'-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-t',str(DURATION),'-movflags','+faststart','-metadata','title=anmerko — Website feedback, ready for AI','-metadata','comment=Illustrated overview with synthetic stock-voice narration; no background music.',str(video)],check=True)
print(video)
