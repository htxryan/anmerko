"""Original, understated electronic bed for the anmerko overview.
All tones are synthesized here; no samples or third-party music.
"""
from pathlib import Path
import os
import wave
import numpy as np

RATE = 48000
DURATION = 29.0
out = np.zeros((round(DURATION * RATE), 2), dtype=np.float64)
rng = np.random.default_rng(84)

def add(signal, start, gain=1, pan=0):
    idx = round(start*RATE)
    end = min(len(out), idx + len(signal))
    if end <= idx: return
    sig = signal[:end-idx] * gain
    out[idx:end, 0] += sig * np.sqrt((1-pan)*0.5)
    out[idx:end, 1] += sig * np.sqrt((1+pan)*0.5)

def note(midi): return 440 * 2**((midi-69)/12)

def pad(chord, start, length):
    t = np.arange(round(length*RATE))/RATE
    env = np.minimum(t/1.3,1) * np.minimum((length-t)/1.7,1)
    env = np.maximum(env,0)**1.5
    for i,midi in enumerate(chord):
        f=note(midi)
        tone=(np.sin(2*np.pi*f*t)+0.3*np.sin(2*np.pi*f*1.0015*t+0.5)+0.08*np.sin(4*np.pi*f*t))
        add(tone*env, start, .013, (i-1.5)/3)

for chord,start in [([45,57,61,64],0),([40,56,59,64],6.2),([42,57,61,66],12.4),([38,57,61,64],18.6)]:
    pad(chord,start,8.9 if start<18 else DURATION-start)

# Glass-like soft notes; restrained enough to sit well below the voice.
for k in range(24):
    start=1.05+k*1.07
    length=2.2
    t=np.arange(round(length*RATE))/RATE
    f=note([76,73,71,73,69,73,76,80][k%8])
    env=(1-np.exp(-t*200))*np.exp(-t*3.1)
    signal=(np.sin(2*np.pi*f*t)+.18*np.sin(2*np.pi*f*2.003*t))*env
    add(signal,start,.025,[-.38,.2,-.15,.4][k%4])
    add(signal*.23,start+.25,.025,-[-.38,.2,-.15,.4][k%4])

# Delicate transitions, with a filtered air texture rather than loud swooshes.
for start in [4.6,8.6,14.1,19.1,23.0]:
    length=.75
    t=np.arange(round(length*RATE))/RATE
    noise=rng.normal(0,1,len(t))
    smooth=np.convolve(noise,np.ones(22)/22,mode='same')
    env=np.sin(np.pi*t/length)**2
    add(smooth*env,start,.043)

fadein=np.minimum(np.arange(len(out))/RATE/1.2,1)
fadeout=np.minimum((DURATION-np.arange(len(out))/RATE)/1.5,1)
out*=np.maximum(fadein*fadeout,0)[:,None]
path=Path(os.environ.get("ANMERKO_MEDIA_OUTPUT", Path(__file__).resolve().parent / "build"))/'score.wav'
path.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(path),'wb') as wav:
    wav.setnchannels(2);wav.setsampwidth(2);wav.setframerate(RATE)
    wav.writeframes((np.clip(out,-1,1)*32767).astype('<i2').tobytes())
print(path)
print('Peak dBFS:',20*np.log10(np.max(np.abs(out))))
print('RMS dBFS:',20*np.log10(np.sqrt(np.mean(out**2))))
