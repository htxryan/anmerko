"""Generate standard neural-voice narration; script contains only public product copy."""
import argparse,asyncio,json,subprocess,os
from pathlib import Path
import edge_tts,imageio_ffmpeg,numpy as np
import wave
ROOT=Path(os.environ.get("ANMERKO_MEDIA_OUTPUT", Path(__file__).resolve().parent / "build"))
VOICE='en-US-AvaMultilingualNeural'
VOICES=[VOICE]*6
SCRIPTS=[
'Meet anmerko. Turn website feedback into a clear brief for your AI agent.',
'Point to an element. Add a comment.',
'Capture a screenshot, or leave feedback for the whole page.',
'Then copy your prompt, with the page context included.',
"Paste it into your AI agent. You're ready to go.",
'Easy, universal, and private. Try anmerko at anmerko dot com.'
]
# Captions retain the canonical spelling. The user selected pronunciation
# audition 2: AvaMultilingualNeural at +5%, with "ahn-mare-koh".
SPOKEN_SCRIPTS=[text.replace('anmerko','ahn-mare-koh') for text in SCRIPTS]
parser=argparse.ArgumentParser()
parser.add_argument('--segments',type=int,nargs='*',choices=range(1,7),
                    help='Regenerate only these clips; empty updates timing from existing audio.')
args=parser.parse_args()
STARTS=[.2,5.5,9.3,14.65,19.65,23.5]
async def create(i,text):
 p=ROOT/'audio'/f'{i+1:02d}.mp3'
 await asyncio.wait_for(edge_tts.Communicate(text,VOICES[i],rate='+5%').save(str(p)),timeout=25)
 print('Created',p.name,flush=True)
 return p
async def main():
 (ROOT/'audio').mkdir(parents=True,exist_ok=True)
 paths=[ROOT/'audio'/f'{i+1:02d}.mp3' for i in range(len(SCRIPTS))]
 await asyncio.gather(*(create(i,t) for i,t in enumerate(SPOKEN_SCRIPTS)
                        if args.segments is None or i+1 in args.segments))
 segments=[]
 for i,p in enumerate(paths):
  data=subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-i',str(p),'-f','f32le','-ar','48000','-ac','1','-'],capture_output=True,check=True).stdout
  signal=np.frombuffer(data,dtype='<f4').copy()
  active=np.flatnonzero(np.abs(signal)>.002)
  a=max(0,active[0]-2400);b=min(len(signal),active[-1]+6000)
  signal=signal[a:b]
  end=STARTS[i]+len(signal)/48000
  wavp=p.with_suffix('.wav')
  with wave.open(str(wavp),'wb') as w:
   w.setnchannels(1);w.setsampwidth(2);w.setframerate(48000)
   w.writeframes((np.clip(signal,-1,1)*32767).astype('<i2').tobytes())
  seg={'file':wavp.name,'text':SCRIPTS[i],'spoken_text':SPOKEN_SCRIPTS[i],'voice':VOICES[i],'start':STARTS[i],'duration':len(signal)/48000,'end':end}
  print(seg,flush=True);segments.append(seg)
 (ROOT/'audio'/'segments.json').write_text(json.dumps({'voice':VOICE,'rate':'+5%','synthetic':True,'segments':segments},indent=2)+'\n')
asyncio.run(main())
