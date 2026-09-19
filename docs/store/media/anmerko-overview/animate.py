#!/usr/bin/env python3
"""Render anmerko's silent 29.0s product overview with Skia.

Usage:
  python animate.py --stills
  python animate.py --full
"""
from __future__ import annotations

import argparse, math, os
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import skia
from PIL import Image, ImageDraw

W, H, FPS, DURATION = 1920, 1080, 30, 29.0
ROOT = Path(os.environ.get("ANMERKO_MEDIA_OUTPUT", Path(__file__).resolve().parent / "build"))
FRAMES = ROOT / "frames"
VIDEO = ROOT / "silent.mp4"
CONTACT = ROOT / "contact-sheet.png"
CROP_REVIEW = ROOT / "crop-drag-review.png"
TRANSITION_REVIEW = ROOT / "feedback-transition-review.png"
FONT = "/System/Library/Fonts/SFNS.ttf"

# Scene boundaries are deliberately centralized for easy VO retiming.
S1, S2, S3, S4, S5, S6, END = 0.0, 5.0, 9.0, 14.5, 19.5, 23.4, 29.0
C = {"ink":"#15171b", "ink2":"#25272c", "grey":"#666970", "blue":"#345ee9",
     "blue2":"#244bd0", "pale":"#e8edff", "paper":"#fbfaf7", "white":"#ffffff"}

def color(h, a=1):
    h=h.lstrip('#')
    if len(h)==3: h=''.join(ch*2 for ch in h)
    return skia.ColorSetARGB(int(255*a),int(h[0:2],16),int(h[2:4],16),int(h[4:6],16))
def clamp(x,a=0,b=1): return max(a,min(b,x))
def ease(x):
    x=clamp(x); return 1-(1-x)**3
def smooth(x):
    x=clamp(x); return x*x*(3-2*x)
def pop(x):
    x=clamp(x); return 1 + (1-x)*math.sin(x*math.pi*2.2)*0.23 if x else 0
def local(t,a,b): return clamp((t-a)/(b-a))
def paint(fill, alpha=1, style=skia.Paint.kFill_Style, sw=1):
    return skia.Paint(Color=color(fill,alpha), AntiAlias=True, Style=style, StrokeWidth=sw)

REG=skia.Typeface.MakeFromFile(FONT)
FM=skia.FontMgr.RefDefault()
def typeface(weight=400):
    style=skia.FontStyle(weight, skia.FontStyle.kNormal_Width, skia.FontStyle.kUpright_Slant)
    return FM.matchFamilyStyle("SF Pro Display",style) or FM.matchFamilyStyle("Helvetica Neue",style) or REG
def text(c,s,x,y,size,fill=C["ink"],weight=400,alpha=1,align="left"):
    f=skia.Font(typeface(weight),size); p=paint(fill,alpha)
    if align!="left":
        width=f.measureText(s)
        x-= width/2 if align=="center" else width
    c.drawString(s,x,y,f,p)
def wrapped_text(c,s,x,y,max_width,size,line_height,fill,weight=400,alpha=1):
    f=skia.Font(typeface(weight),size); words=s.split(); lines=[]; current=""
    for word in words:
        candidate=f"{current} {word}".strip()
        if current and f.measureText(candidate)>max_width:
            lines.append(current); current=word
        else: current=candidate
    if current: lines.append(current)
    for i,row in enumerate(lines): text(c,row,x,y+i*line_height,size,fill,weight,alpha)
def rr(c,x,y,w,h,r,fill,alpha=1,stroke=None,sw=1):
    c.drawRoundRect(skia.Rect.MakeXYWH(x,y,w,h),r,r,paint(fill,alpha))
    if stroke: c.drawRoundRect(skia.Rect.MakeXYWH(x,y,w,h),r,r,paint(stroke,alpha,skia.Paint.kStroke_Style,sw))
def shadow(c,x,y,w,h,r,alpha=.14,dy=18,spread=0):
    # Several soft translucent layers read as a premium diffuse shadow at video scale.
    for i in range(8,0,-1):
        q=i/8; rr(c,x-spread*q,y+dy*q-spread*q,w+2*spread*q,h+2*spread*q,r+spread*q,"#182035",alpha*(1-q*.78)/8)
def line(c,x1,y1,x2,y2,fill,sw=2,alpha=1): c.drawLine(x1,y1,x2,y2,paint(fill,alpha,skia.Paint.kStroke_Style,sw))

def arrow(c,x,y,scale=1,fill="#fff",alpha=1):
    p=skia.Path(); p.moveTo(x,y+18*scale); p.lineTo(x+18*scale,y); p.moveTo(x+2*scale,y); p.lineTo(x+18*scale,y); p.lineTo(x+18*scale,y+16*scale)
    c.drawPath(p,paint(fill,alpha,skia.Paint.kStroke_Style,5*scale))
def wordmark(c,x,y,fill=C["ink"],alpha=1,size=30,icon_scale=1):
    side=size*1.15*icon_scale; top=y-size*.86-(side-size*1.15)/2
    rr(c,x,top,side,side,side*.22,C["blue"],alpha)
    arrow(c,x+side*.28,top+side*.29,side/55,"#fff",alpha)
    text(c,"anmerko",x+side+size*.30,y,size,fill,650,alpha)
def cursor(c,x,y,scale=1,alpha=1):
    p=skia.Path(); p.moveTo(x,y); p.lineTo(x+3*scale,y+26*scale); p.lineTo(x+10*scale,y+19*scale); p.lineTo(x+17*scale,y+35*scale); p.lineTo(x+23*scale,y+32*scale); p.lineTo(x+16*scale,y+17*scale); p.lineTo(x+27*scale,y+16*scale); p.close()
    c.drawPath(p,paint("#ffffff",alpha)); c.drawPath(p,paint(C["ink"],alpha,skia.Paint.kStroke_Style,2*scale))

def crop_geometry(x,y,w,h,progress):
    """Selection rect and live pointer endpoint from one undistorted drag progress."""
    ix,iy,iw,ih=x+w*.46,y+145,w*.31,h*.40
    x1,y1=ix-iw*.13,iy+ih*.16
    x2,y2=ix+iw*.504,iy+ih*.867
    p=clamp(progress)
    return x1,y1,x1+(x2-x1)*p,y1+(y2-y1)*p

def crop_crosshair(c,x,y,alpha=1):
    c.drawCircle(x,y,8,paint("#ffffff",alpha))
    c.drawCircle(x,y,8,paint(C["blue"],alpha,skia.Paint.kStroke_Style,3))
    line(c,x-17,y,x+17,y,C["blue"],2,alpha); line(c,x,y-17,x,y+17,C["blue"],2,alpha)

def click_pulse(c,x,y,amount,alpha=1):
    if amount<=0: return
    c.drawCircle(x,y,12+22*amount,paint(C["blue"],alpha*(1-amount)*.25))
    c.drawCircle(x,y,9+12*amount,paint(C["blue"],alpha*(1-amount),skia.Paint.kStroke_Style,3))

def feature_icon(c,kind,x,y,a=1,tile=96):
    """Faithful scaled recreation of the homepage's 44px feature icon."""
    scale=tile/44; inset=(tile-24*scale)/2
    rr(c,x,y,tile,tile,12*scale,"#eef2ff",a)
    c.save(); c.translate(x+inset,y+inset); c.scale(scale,scale)
    p=skia.Path(); stroke=paint("#2851d2",a,skia.Paint.kStroke_Style,1.75)
    stroke.setStrokeCap(skia.Paint.kRound_Cap); stroke.setStrokeJoin(skia.Paint.kRound_Join)
    if kind=="easy":
        p.moveTo(13,2); p.lineTo(4,14); p.lineTo(11,14); p.lineTo(10,22); p.lineTo(20,10); p.lineTo(13,10); p.lineTo(14,2); p.close(); c.drawPath(p,stroke)
    elif kind=="universal":
        c.drawCircle(12,12,9,stroke); c.drawOval(skia.Rect.MakeLTRB(8,3,16,21),stroke); c.drawLine(3,12,21,12,stroke)
    else:
        c.drawRoundRect(skia.Rect.MakeXYWH(5,10,14,11),2,2,stroke)
        arc=skia.Path(); arc.moveTo(8,10); arc.lineTo(8,7); arc.cubicTo(8,1.67,16,1.67,16,7); arc.lineTo(16,10); c.drawPath(arc,stroke)
        c.drawLine(12,14,12,17,stroke)
    c.restore()

def feature_row(c,a):
    left,width,gap=120,520,60
    line(c,left,302,1800,302,"#e1e6ef",2,a)
    items=[("easy","Easy","Simple and quick to use. Easily copy + paste comments to your agent of choice."),
           ("universal","Universal","Works on any website, on desktop or mobile. Capture feedback about anything."),
           ("private","Private","Stored in your browser. Shared only when you choose. Free to use.")]
    for i,(kind,title,body) in enumerate(items):
        x=left+i*(width+gap); feature_icon(c,kind,x,340,a,96)
        text(c,title,x,536,68,"#202b41",700,a)
        wrapped_text(c,body,x,610,width,38,52,"#596578",400,a)

def browser(c,x,y,w,h,alpha=1,sidebar=0, selected=0, pin=0, card=0, crop=0, second=0, whole=0):
    shadow(c,x,y,w,h,24,.12*alpha,20,10); rr(c,x,y,w,h,24,C["ink"],alpha,stroke="#373a40",sw=2)
    rr(c,x,y,w,60,24,C["ink2"],alpha); c.drawRect(skia.Rect.MakeXYWH(x,y+36,w,24),paint(C["ink2"],alpha)); line(c,x,y+60,x+w,y+60,"#3b3e45",2,alpha)
    for j in range(3): c.drawCircle(x+28+j*20,y+30,5,paint("#666970",alpha))
    rr(c,x+w*.32,y+18,w*.35,22,11,"#34363c",alpha)
    # Page: geometric, intentionally large and legible.
    rr(c,x+45,y+91,30,30,8,"#555860",alpha); rr(c,x+90,y+101,105,11,5,"#666970",alpha)
    for j in range(3): rr(c,x+w*.48+j*76,y+102,54,7,3,"#484b52",alpha)
    hx,hy=x+46,y+167
    rr(c,hx,hy,w*.32,24,6,"#c2c4c9",alpha); rr(c,hx,hy+37,w*.25,24,6,"#c2c4c9",alpha)
    rr(c,hx,hy+92,w*.28,9,4,"#60636b",alpha); rr(c,hx,hy+112,w*.22,9,4,"#60636b",alpha)
    rr(c,hx,hy+157,150,45,9,"#50535b",alpha); rr(c,hx+28,hy+175,94,9,4,"#c2c4c9",alpha)
    ix,iy,iw,ih=x+w*.46,y+145,w*.31,h*.40
    rr(c,ix,iy,iw,ih,14,"#292c32",alpha,stroke="#454850",sw=2); c.drawCircle(ix+iw*.76,iy+48,22,paint("#4d515a",alpha))
    p=skia.Path(); p.moveTo(ix+20,iy+ih-18); p.lineTo(ix+iw*.3,iy+ih*.47); p.lineTo(ix+iw*.55,iy+ih*.73); p.lineTo(ix+iw*.7,iy+ih*.56); p.lineTo(ix+iw-18,iy+ih-18); p.close(); c.drawPath(p,paint("#454952",alpha))
    line(c,x+45,y+h-75,x+w*.77,y+h-75,"#3b3e45",2,alpha)
    if selected:
        a=ease(selected); pad=10; rr(c,hx-pad,hy-pad,(w*.32)+pad*2,44+pad,9,C["blue"],.09*a,stroke=C["blue"],sw=4)
    if pin:
        s=pop(pin); px=hx+w*.32+10; py=hy+5
        c.drawCircle(px,py,28*s,paint(C["blue"],.15*alpha)); c.drawCircle(px,py,19*s,paint(C["blue"],alpha)); c.drawCircle(px,py,19*s,paint("#a9bdff",alpha,skia.Paint.kStroke_Style,2)); text(c,"1",px,py+7*s,18*s,"#fff",700,alpha,"center")
    if crop:
        x1,y1,x2,y2=crop_geometry(x,y,w,h,crop)
        rr(c,x1,y1,max(2,x2-x1),max(2,y2-y1),3,C["blue"],.14*alpha,stroke="#6f91ff",sw=5)
        if crop>=1:
            for xx,yy in [(x1,y1),(x2,y1),(x1,y2),(x2,y2)]: rr(c,xx-7,yy-7,14,14,2,"#fff",alpha,stroke=C["blue"],sw=3)
    if sidebar:
        a=ease(sidebar); pw=w*.30; px=x+w-pw+35*(1-a); py=y-25+25*(1-a)
        shadow(c,px,py,pw,h+50,20,.23*a,20,12); rr(c,px,py,pw,h+50,20,C["blue"],a,stroke="#7996f4",sw=1)
        wordmark(c,px+28,py+44,"#fff",a,26); line(c,px+22,py+70,px+pw-22,py+70,"#fff",1,a*.24)
        text(c,"Page comments",px+24,py+107,18,"#fff",650,a)
        if card:
            ca=ease(card); cy=py+130+22*(1-ca); shadow(c,px+20,cy,pw-40,116,12,.08*ca,8,4); rr(c,px+20,cy,pw-40,116,12,"#fff",.14*ca,stroke="#fff",sw=1)
            c.drawCircle(px+48,cy+30,15,paint("#fff",ca)); text(c,"1",px+48,cy+36,15,C["blue"],700,ca,"center")
            text(c,"Headline",px+73,cy+36,17,"#fff",650,ca)
            msg="Make the headline clearer."
            chars=int(len(msg)*clamp((card-.28)/.72)); text(c,msg[:chars],px+38,cy+78,17,"#fff",500,ca)
        if second:
            ca=ease(second); cy=py+258+18*(1-ca); rr(c,px+20,cy,pw-40,100,12,"#fff",.14*ca,stroke="#fff",sw=1)
            rr(c,px+36,cy+20,74,58,8,"#24272d",ca); rr(c,px+44,cy+29,58,34,5,"#4b4f58",ca)
            text(c,"Screenshot",px+126,cy+40,17,"#fff",650,ca); text(c,"Use a simpler image.",px+126,cy+69,15,"#fff",450,ca)
        if whole:
            ca=ease(whole); cy=py+370+18*(1-ca); rr(c,px+20,cy,pw-40,80,12,"#fff",.14*ca,stroke="#fff",sw=1)
            text(c,"Whole page",px+38,cy+30,16,"#fff",650,ca); text(c,"Keep the page easy to scan.",px+38,cy+58,15,"#fff",450,ca)
        if card:
            rr(c,px+20,py+h-2,pw-40,48,10,"#fff",a); text(c,"Copy prompt",px+pw/2,py+h+29,17,C["blue2"],650,a,"center")

def prompt_sheet(c,x,y,w,h,a=1, copied=0):
    shadow(c,x,y,w,h,24,.14*a,18,10); rr(c,x,y,w,h,24,"#ffffff",a,stroke="#e1e4ec",sw=2)
    text(c,"ANMERKO PROMPT",x+42,y+54,15,C["blue"],700,a); text(c,"Homepage feedback",x+42,y+106,34,C["ink"],700,a)
    rr(c,x+42,y+132,w-84,55,12,"#f2f4f8",a); text(c,"anmerko.com  ·  Homepage",x+62,y+167,18,"#60636b",500,a)
    line(c,x+42,y+220,x+w-42,y+220,"#e5e7ec",2,a)
    for num,title,msg,yy in [("1","Headline","Make the headline clearer.",260),("2","Screenshot","Use a simpler image.",355),("•","Whole page","Keep the page easy to scan.",450)]:
        c.drawCircle(x+58,y+yy,18,paint(C["blue"],a)); text(c,num,x+58,y+yy+6,16,"#fff",700,a,"center"); text(c,title,x+92,y+yy-2,18,C["ink"],650,a); text(c,msg,x+92,y+yy+29,18,"#555861",450,a)
    rr(c,x+42,y+h-78,w-84,48,10,C["blue"],a); text(c,"Copied" if copied>.6 else "Copy prompt",x+w/2,y+h-47,17,"#fff",650,a,"center")

def agent_card(c,x,y,w,h,a=1, prompt_a=1):
    shadow(c,x,y,w,h,26,.15*a,20,12); rr(c,x,y,w,h,26,"#ffffff",a,stroke="#e2e4ea",sw=2)
    c.drawCircle(x+50,y+48,18,paint(C["ink"],a)); arrow(c,x+42,y+39,.45,"#fff",a); text(c,"AI agent",x+82,y+56,24,C["ink"],650,a)
    line(c,x+30,y+82,x+w-30,y+82,"#e6e8ed",2,a)
    yy=y+116
    if prompt_a:
        rr(c,x+34,yy,w-68,150,17,"#f3f5f9",a*prompt_a); text(c,"Homepage feedback",x+58,yy+42,20,C["ink"],650,a*prompt_a)
        text(c,"3 clear comments with page context",x+58,yy+76,17,"#60636b",450,a*prompt_a)
        for j in range(3): rr(c,x+58,yy+101+j*13,w*.42-j*30,6,3,"#aeb3be",a*prompt_a)
    rr(c,x+34,y+h-74,w-68,46,12,C["ink"],a); text(c,"Ready to send",x+w/2,y+h-44,17,"#fff",650,a,"center")

def background(c,t):
    c.clear(color(C["paper"]));
    # Subtle animated wash, kept away from text for contrast.
    for i in range(11,0,-1):
        rad=150+i*42; c.drawCircle(1660+math.sin(t*.25)*20,130+math.cos(t*.2)*15,rad,paint(C["pale"],.012*i))
    if t<S5: wordmark(c,78,78,C["ink"],.92,28)

def feedback_scene(c,t):
    bx,by,bw,bh=180,252,1440,700
    if t<S3:
        selected=ease(local(t,5.9,6.55)); pin=ease(local(t,6.35,6.9)); card=ease(local(t,6.85,8.4))
        browser(c,bx,by,bw,bh,1,1,selected,pin,card)
        q=smooth(local(t,5.4,6.25)); cursor(c,560+(835-560)*q,700+(427-700)*q,1.25)
        return
    drag=local(t,9.55,11.05); crop=drag if t>=9.55 else 0
    second=ease(local(t,11.2,12.1)); whole=ease(local(t,12.2,13.5))
    browser(c,bx,by,bw,bh,1,1,1,1,1,crop,second,whole)
    x1,y1,x2,y2=crop_geometry(bx,by,bw,bh,drag)
    if t<9.55:
        # Crossfade the arrow into the crop tool at the same pointer location.
        q=smooth(local(t,9.0,9.52)); px=835+(x1-835)*q; py=427+(y1-427)*q
        tool=smooth(local(t,9.0,9.3))
        cursor(c,px,py,1.25,1-tool); crop_crosshair(c,px,py,tool)
    elif t<=11.42:
        fade=1-smooth(local(t,11.12,11.42))
        if t<=11.12: crop_crosshair(c,x2,y2,1)
        else: crop_crosshair(c,x2+100*smooth(local(t,11.12,11.42)),y2-55*smooth(local(t,11.12,11.42)),fade)
        click_pulse(c,x1,y1,local(t,9.55,9.78))
        click_pulse(c,x2,y2,local(t,11.05,11.25))

def scene(c,t):
    background(c,t)
    if t<S2:
        p=local(t,S1,S2); intro=ease(local(t,.15,1.0));
        text(c,"Your feedback.",110,360,88,C["ink"],700,intro); text(c,"Ready for AI.",110,455,88,C["blue"],700,ease(local(t,.45,1.3)))
        text(c,"Website feedback, shaped into a clear brief.",116,523,28,"#555861",450,ease(local(t,.85,1.7)))
        scale=.80; bx=1020+80*(1-ease(local(t,.2,1.4))); by=236
        c.save(); c.translate(bx,by); c.scale(scale,scale); browser(c,0,0,930,590,ease(local(t,.2,1.2)),ease(local(t,1.0,2.4)),card=ease(local(t,2.2,3.5))); c.restore()
    elif t<S4:
        # One fixed stage carries element, screenshot and page feedback.
        # Keep the heading and browser anchored through the narration boundary.
        text(c,"Every kind of feedback.",120,150,60,C["ink"],700,ease(local(t,S2,S2+.7)))
        for label,x in [("INLINE",120),("SCREENSHOT",300),("WHOLE PAGE",530)]:
            label_a=ease(local(t,5.4,5.9)) if label=="INLINE" else smooth(local(t,8.85,9.35))
            active=label=="INLINE" or (label=="SCREENSHOT" and t>=9.55) or (label=="WHOLE PAGE" and t>=12.2)
            text(c,label,x,205,16,C["blue"] if active else "#8c9099",700,label_a)
        feedback_scene(c,t)
    elif t<S5:
        p=ease(local(t,S4,S4+.7)); text(c,"Copy your prompt.",120,150,60,C["ink"],700,p)
        bx=80-300*ease(local(t,15.0,16.0)); browser(c,bx,230,1180,680,1,1,1,1,1,1,1,1)
        sh=ease(local(t,15.15,16.2)); sx=1140+500*(1-sh); prompt_sheet(c,sx,242,650,650,sh,ease(local(t,16.0,16.8)))
        # Flow line gently links feedback to the generated brief.
        q=ease(local(t,15.7,16.4)); line(c,1050,565,1125,565,C["blue"],4,q); arrow(c,1100,547,.65,C["blue"],q)
        if 15.72<t<16.65:
            q2=smooth(local(t,15.72,16.08)); cx=1540+(1465-1540)*q2; cy=820+(842-820)*q2
            cursor(c,cx,cy,1.05,1-smooth(local(t,16.38,16.65))); click_pulse(c,1465,842,local(t,16.06,16.34))
    elif t<END:
        if t<S5+0.05: return
        if t<23.4:
            text(c,"Paste into your agent.",120,150,60,C["ink"],700,ease(local(t,S5,S5+.7)))
            sheetx=125+18*ease(local(t,19.7,20.5)); prompt_sheet(c,sheetx,235,625,650,1,1)
            aa=ease(local(t,20.4,21.25)); pasted=ease(local(t,21.25,21.88)); agent_card(c,1120,246,650,620,aa,pasted)
            # The copied prompt travels across the gap before settling.
            mv=smooth(local(t,20.7,21.7)); ox=760+(1050-760)*mv
            oa=1-smooth(local(t,21.55,21.85)); oy=460-70*math.sin(mv*math.pi)
            rr(c,ox,oy,210,62,12,"#fff",oa,stroke="#dfe3eb",sw=2); text(c,"Copied prompt",ox+105,oy+39,17,C["blue"],650,oa,"center")
            if 21.55<t<22.0: click_pulse(c,1184,385,local(t,21.55,21.9))
        else:
            a=ease(local(t,23.4,23.9)); wordmark(c,750,200,"#202b41",a,64,1.05)
            feature_row(c,a)
            text(c,"anmerko.com",960,948,42,"#2851d2",700,a,"center")

def render_frame(t):
    surface=skia.Surface(W,H); scene(surface.getCanvas(),t); img=surface.makeImageSnapshot()
    return np.frombuffer(img.tobytes(),np.uint8).reshape(H,W,4)[:,:,:3].copy()

STILLS=[1.7,6.8,8.3,10.7,13.2,16.6,18.5,21.5,24.3,26.4]
CROP_STILLS=[9.55,9.9,10.3,10.7,11.1]
HANDOFF_STILLS=[16.2,20.7,21.5,22.2]
ENDING_STILLS=[24.0,26.0,28.5]
TRANSITION_STILLS=[8.7,8.97,9.0,9.13,9.3,9.55]
def render_stills():
    FRAMES.mkdir(parents=True,exist_ok=True); ims=[]
    for t in STILLS:
        arr=render_frame(t); path=FRAMES/f"{t:04.1f}s.png"; Image.fromarray(arr).save(path); ims.append((t,Image.fromarray(arr)))
    thumbw,thumbh=576,324; sheet=Image.new("RGB",(thumbw*2,thumbh*5+50*5),(238,238,238)); d=ImageDraw.Draw(sheet)
    for i,(t,im) in enumerate(ims):
        x=(i%2)*thumbw; y=(i//2)*(thumbh+50); sheet.paste(im.resize((thumbw,thumbh),Image.Resampling.LANCZOS),(x,y)); d.text((x+16,y+thumbh+12),f"{t:.1f}s",fill=(25,25,28))
    sheet.save(CONTACT)

def render_crop_review():
    FRAMES.mkdir(parents=True,exist_ok=True); ims=[]
    for t in CROP_STILLS:
        im=Image.fromarray(render_frame(t)); im.save(FRAMES/f"crop-{t:.2f}s.png"); ims.append((t,im))
    tw,th=768,432; sheet=Image.new("RGB",(tw,th*5+46*5),(238,238,238)); d=ImageDraw.Draw(sheet)
    for i,(t,im) in enumerate(ims):
        y=i*(th+46); sheet.paste(im.resize((tw,th),Image.Resampling.LANCZOS),(0,y)); d.text((16,y+th+11),f"{t:.2f}s",fill=(25,25,28))
    sheet.save(CROP_REVIEW)

def render_handoff_review():
    FRAMES.mkdir(parents=True,exist_ok=True)
    for t in HANDOFF_STILLS:
        Image.fromarray(render_frame(t)).save(FRAMES/f"handoff-{t:.1f}s.png")

def render_ending_review():
    FRAMES.mkdir(parents=True,exist_ok=True)
    for t in ENDING_STILLS:
        Image.fromarray(render_frame(t)).save(FRAMES/f"ending-{t:.1f}s.png")

def render_transition_review():
    FRAMES.mkdir(parents=True,exist_ok=True)
    tw,th,label_h=768,432,36
    sheet=Image.new("RGB",(tw*2,(th+label_h)*3),(238,238,238)); d=ImageDraw.Draw(sheet)
    for i,t in enumerate(TRANSITION_STILLS):
        im=Image.fromarray(render_frame(t)); im.save(FRAMES/f"transition-{t:.2f}s.png")
        x=(i%2)*tw; y=(i//2)*(th+label_h)
        sheet.paste(im.resize((tw,th),Image.Resampling.LANCZOS),(x,y))
        d.text((x+16,y+th+10),f"{t:.2f}s",fill=(25,25,28))
    sheet.save(TRANSITION_REVIEW)

def render_full():
    ROOT.mkdir(parents=True,exist_ok=True); exe=imageio_ffmpeg.get_ffmpeg_exe()
    gen=imageio_ffmpeg.write_frames(str(VIDEO),(W,H),fps=FPS,codec="libx264",quality=7,pix_fmt_in="rgb24",pix_fmt_out="yuv420p",macro_block_size=1,ffmpeg_log_level="warning",output_params=["-movflags","+faststart"])
    gen.send(None)
    for i in range(int(DURATION*FPS)):
        gen.send(render_frame(i/FPS))
        if i and i%(FPS*5)==0: print(f"rendered {i/FPS:.0f}s / {DURATION:.1f}s",flush=True)
    gen.close()

if __name__=="__main__":
    ap=argparse.ArgumentParser(); ap.add_argument("--stills",action="store_true"); ap.add_argument("--crop-review",action="store_true"); ap.add_argument("--handoff-review",action="store_true"); ap.add_argument("--ending-review",action="store_true"); ap.add_argument("--transition-review",action="store_true"); ap.add_argument("--full",action="store_true"); args=ap.parse_args()
    if not args.stills and not args.crop_review and not args.handoff_review and not args.ending_review and not args.transition_review and not args.full: args.stills=args.crop_review=args.handoff_review=args.ending_review=args.full=True
    if args.stills: render_stills()
    if args.crop_review: render_crop_review()
    if args.handoff_review: render_handoff_review()
    if args.ending_review: render_ending_review()
    if args.transition_review: render_transition_review()
    if args.full: render_full()
