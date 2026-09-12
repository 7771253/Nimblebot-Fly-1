// ==UserScript==
// @name         NimbleBotFly
// @namespace    cuberealm-v160
// @version      10.3.2
// @match        https://cuberealm.io/*
// @grant        none
// @run-at       document-start
// @license      none
// @description
// @downloadURL https://github.com/7771253/Nimblebot-Fly-1/blob/main/Nimble%20Aimbot%20(Fly).js
// @updateURL https://github.com/7771253/Nimblebot-Fly-1/blob/main/Nimble%20Aimbot%20(Fly).js
// ==/UserScript==
(function () {
  'use strict';

  if (window.__CR_V10) return;
  window.__CR_V10 = true;

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const BONE_Y_OFFSET   = 0.05;
  let LOCK_GAIN     = 0.12;
  let LOCK_MAX_PX   = 50;
  let LOCK_DEADZONE = 2;
  let LERP_SMOOTH   = 1;
  let AURA_RANGE    = 8;
  const ATTACK_INTERVAL = 1;
  const FRIENDS = new Set([
    1234,
    5555
  ]);

  const PRIORITY = new Set([
    9999
  ]);

  // Fly-specific defaults
  const FLY_SPEED = 12;
  const FLY_BOOST = 28;
  const FLY_VERT  = 10;

  // ─── STATE ─────────────────────────────────────────────────────────────────
  let espOn       = true;
  let lockOn      = false;
  let auraOn      = false;
  let _lockTarget = null;
  let _lerpX = 0, _lerpY = 0;
  let flyOn = false;
  let _lastSwing  = 0;
  let _mouseHeld  = false;
  let lastFrame = performance.now();
  const _allScenes = [];
  const _allCams   = [];

  // Fly state & helpers (namespaced to avoid collisions)
  let __crFly_flyPos = null;
  let __crFly_localMesh = null;
  let __crFly_localNode = null;
  let __crFly_releasingGameKeys = false;
  const __crFly_flyKeys = new Set();
  const __crFly_FLY_HELD = new Set(['KeyW','KeyA','KeyS','KeyD','Space','ShiftLeft','ShiftRight','ControlLeft','ControlRight']);

  // ─── THREE HOOK ────────────────────────────────────────────────────────────
  const _hookTimer = setInterval(() => {
    if (!window.webpackChunkcuberealm_client) return;
    try {
      let __wp = null;
      webpackChunkcuberealm_client.push([[Symbol()], {}, r => __wp = r]);
      const THREE = __wp('16259');
      window.__THREE = THREE;
      if (THREE.__crV10Hooked) { clearInterval(_hookTimer); return; }
      const orig = THREE.Object3D.prototype.updateMatrixWorld;
      THREE.Object3D.prototype.updateMatrixWorld = function (...a) {
        if (this.isScene && !_allScenes.includes(this)) _allScenes.push(this);
        if (this.isPerspectiveCamera && !_allCams.includes(this)) _allCams.push(this);
        return orig.apply(this, a);
      };
      THREE.__crV10Hooked = true;
      clearInterval(_hookTimer);
    } catch (e) {}
  }, 50);


  // ─── HELPERS ───────────────────────────────────────────────────────────────
  function getScene() {
    let best = null, bestN = 0;
    _allScenes.forEach(s => {
      let n = 0; s.traverse(o => { if (o.isSkinnedMesh) n++; });
      if (n > bestN) { bestN = n; best = s; }
    });
    return best;
  }

  function getCam() {
    return _allCams.find(c => {
      const e = c.matrixWorldInverse?.elements;
      if (!e) return false;
      const isId = e[0]===1 && e[5]===1 && e[10]===1 && e[15]===1;
      return !isId && Math.hypot(c.position.x, c.position.y, c.position.z) > 0.01;
    }) || null;
  }

  // ─── w2s FROM SCRIPT A (MERGED) ────────────────────────────────────────────
  function w2s(wx, wy, wz, cam, W, H) {
    try {
      const mv = cam.matrixWorldInverse.elements;
      const p = cam.projectionMatrix.elements;

      const vx = mv[0]*wx + mv[4]*wy + mv[8]*wz + mv[12];
      const vy = mv[1]*wx + mv[5]*wy + mv[9]*wz + mv[13];
      const vz = mv[2]*wx + mv[6]*wy + mv[10]*wz + mv[14];

      if (vz > 0) return null;

      const cx = p[0]*vx + p[8]*vz;
      const cy = p[5]*vy + p[9]*vz;
      const cw = p[11]*vz;

      if (cw === 0) return null;

      return {
        x: (cx / cw + 1) / 2 * W,
        y: (1 - cy / cw) / 2 * H
      };
    } catch (e) {
      return null;
    }
  }

  // ─── BONES ─────────────────────────────────────────────────────────────────
  const BONE_NAMES = ['Head','Upper','Lower','LeftLeg','LeftLegSeg','RightLeg','RightLegSeg','Whole_1'];
  const AIM_BONES  = new Set(['Head','Upper','Lower','LeftLeg','LeftLegSeg','RightLeg','RightLegSeg']);
  const SKEL = [['Head','Upper'],['Upper','Lower'],['Lower','LeftLeg'],['LeftLeg','Whole_1'],['Lower','RightLeg'],['RightLeg','Whole_1']];
  const JOINT = {
    Head:{r:5,rgb:'255,60,80'},Upper:{r:3.5,rgb:'255,160,60'},Lower:{r:3,rgb:'100,255,150'},
    LeftLeg:{r:2.5,rgb:'80,150,255'},LeftLegSeg:{r:2,rgb:'60,120,255'},
    RightLeg:{r:2.5,rgb:'80,150,255'},RightLegSeg:{r:2,rgb:'60,120,255'},Whole_1:{r:2,rgb:'160,160,160'},
  };

  function getPlayers(scene) {
    if (!scene || !window.__THREE) return [];
    const V3 = window.__THREE.Vector3, out = [];
    scene.traverse(obj => {
      if (!obj.isSkinnedMesh || obj.name !== 'Whole') return;
      if (!obj.parent?.children.find(c => c.type === 'Sprite')) return;
      const wp = new V3(); obj.getWorldPosition(wp);
      if (!isFinite(wp.x)) return;
      const bones = {};
      obj.skeleton?.bones.forEach(b => {
        if (!BONE_NAMES.includes(b.name)) return;
        const bp = new V3(); b.getWorldPosition(bp); bp.y += BONE_Y_OFFSET; bones[b.name] = bp;
      });
      if (!bones['Head']) return;
      const netId =
        obj.entityId ??
        obj.userData?.id ??
        obj.parent?.entityId ??
        obj.parent?.userData?.id ??
        obj.id;

      out.push({
        pos: wp,
        bones,
        id: netId
      });
    });
    return out;
  }

  // ─── AIM ───────────────────────────────────────────────────────────────────
  function findClosest(players, cam) {

    let priorityBest = null;
    let priorityDist = Infinity;

    let normalBest = null;
    let normalDist = Infinity;

    players.forEach(p => {

      if (FRIENDS.has(p.id)) return;

      const d = Math.hypot(
        p.pos.x - cam.position.x,
        p.pos.y - cam.position.y,
        p.pos.z - cam.position.z
      );

      if (PRIORITY.has(p.id)) {
        if (d < priorityDist) {
          priorityDist = d;
          priorityBest = p;
        }
        return;
      }

      if (d < normalDist) {
        normalDist = d;
        normalBest = p;
      }
    });

    return priorityBest || normalBest;
  }

  function aimAt(target, cam, canvas, W, H) {
    const cx = W/2, cy = H/2;
    let aimBone = null, aimBoneDist = Infinity;
    Object.entries(target.bones).forEach(([name, bp]) => {
      if (!AIM_BONES.has(name)) return;
      const s = w2s(bp.x, bp.y, bp.z, cam, W, H);
      if (!s) return;
      const d = Math.hypot(s.x-cx, s.y-cy);
      if (d < aimBoneDist) { aimBoneDist = d; aimBone = bp; }
    });
    if (!aimBone) aimBone = target.bones['Head'] || target.bones['Upper'];
    if (!aimBone) return;

    const screen = w2s(aimBone.x, aimBone.y, aimBone.z, cam, W, H);
    if (screen) {
      const errX = screen.x - cx, errY = screen.y - cy;
      if (Math.hypot(errX, errY) < LOCK_DEADZONE) { _lerpX *= 0.8; _lerpY *= 0.8; return; }

      _lerpX += (errX - _lerpX) * LERP_SMOOTH;
      _lerpY += (errY - _lerpY) * LERP_SMOOTH;

      const moveX = Math.max(-LOCK_MAX_PX,
        Math.min(LOCK_MAX_PX, _lerpX * LOCK_GAIN));

      const moveY = Math.max(-LOCK_MAX_PX,
        Math.min(LOCK_MAX_PX, _lerpY * LOCK_GAIN));
      const el = document.pointerLockElement || canvas;
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, cancelable:true, movementX:moveX, movementY:moveY, clientX:cx, clientY:cy }));
      if (el !== document) document.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, cancelable:true, movementX:moveX, movementY:moveY }));
    } else {
      const tx = aimBone.x-cam.position.x, ty = aimBone.y-cam.position.y, tz = aimBone.z-cam.position.z;
      const len = Math.hypot(tx,ty,tz); if (!len) return;
      const mw = cam.matrixWorld.elements;
      const eX = (tx/len*mw[0]+ty/len*mw[1]+tz/len*mw[2]);
      const eY = -(tx/len*mw[4]+ty/len*mw[5]+tz/len*mw[6]);
      const cl = (v,m) => Math.max(-m,Math.min(m,v));
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, cancelable:true, movementX:cl(eX*LOCK_MAX_PX,LOCK_MAX_PX), movementY:cl(eY*LOCK_MAX_PX,LOCK_MAX_PX), clientX:cx, clientY:cy }));
    }
  }

  function pressClick(canvas) {
    if (_mouseHeld) return; _mouseHeld = true;
    const cx = innerWidth/2, cy = innerHeight/2;
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true, button:0, clientX:cx, clientY:cy }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, button:0 }));
  }

  function releaseClick(canvas) {
    if (!_mouseHeld) return; _mouseHeld = false;
    const cx = innerWidth/2, cy = innerHeight/2;
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles:true, cancelable:true, button:0, clientX:cx, clientY:cy }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, button:0 }));
  }

  function repeatClick(canvas) {
    const now = performance.now();
    if (now - _lastSwing < ATTACK_INTERVAL) return;
    _lastSwing = now;
    releaseClick(canvas);
    setTimeout(() => pressClick(canvas), 10);
  }

  // ─── doLockOn FROM SCRIPT A (MERGED) ───────────────────────────────────────
  function doLockOn(players, cam, canvas, W, H) {
    if (!players.length || !cam) {
      _lockTarget = null;
      return;
    }

    if (_lockTarget) {
      const stillExists = players.some(p => p.id === _lockTarget.id);
      if (!stillExists) _lockTarget = null;
    }

    if (!_lockTarget) {
      let minDist = Infinity;
      players.forEach(p => {
        const screenPos = w2s(p.pos.x, p.pos.y, p.pos.z, cam, W, H);
        if (screenPos) {
          const dist = Math.hypot(screenPos.x - W/2, screenPos.y - H/2);
          if (dist < minDist) {
            minDist = dist;
            _lockTarget = p;
          }
        }
      });
    }

    const target = players.find(p => p.id === _lockTarget?.id);
    if (!target) {
      _lockTarget = null;
      return;
    }

    const targetBone = target.bones['Upper'] || target.pos;
    if (cam.lookAt) {
      cam.lookAt(targetBone);
      if (cam.parent) cam.rotation.setFromRotationMatrix(cam.matrixWorld);
    }

    const screenPos = w2s(targetBone.x, targetBone.y, targetBone.z, cam, W, H);
    if (!screenPos) return;

    const el = document.pointerLockElement || canvas || document.body;
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      movementX: screenPos.x - W/2,
      movementY: screenPos.y - H/2
    }));
  }

  function doAura(players, cam, canvas, W, H) {
    const closest = findClosest(players, cam);
    const dist = closest ? Math.hypot(closest.pos.x-cam.position.x, closest.pos.y-cam.position.y, closest.pos.z-cam.position.z) : Infinity;
    _lockTarget = (closest && dist <= AURA_RANGE) ? closest : null;
    if (!_lockTarget) { releaseClick(canvas); _lerpX = 0; _lerpY = 0; return; }
    aimAt(_lockTarget, cam, canvas, W, H);
    pressClick(canvas);
    repeatClick(canvas);
  }

  // ─── Fly helpers (namespaced: __crFly_*) ───────────────────────────────────
  function __crFly_copyPos(v) { return { x:v.x, y:v.y, z:v.z }; }

  function __crFly_isRealLocalMesh(obj) {
    if (!obj?.parent) return false;
    if (!obj.isSkinnedMesh || obj.name !== 'Whole') return false;
    if ((obj.skeleton?.bones?.length||0) < 10) return false;
    // local player meshes typically *don't* have a Sprite child — invert A's check:
    if (obj.parent?.children?.find(c=>c.type==='Sprite')) return false;
    if (!obj.parent.parent || obj.parent.parent.isScene) return false;
    return true;
  }

  function __crFly_findLocalMesh() {
    if (__crFly_isRealLocalMesh(__crFly_localMesh)) return __crFly_localMesh;
    let found=null, bestScore=Infinity;
    for (const scene of _allScenes) {
      try {
        scene.traverse(obj => {
          if (!__crFly_isRealLocalMesh(obj)) return;
          const node=obj.parent;
          const score=Math.hypot(node.position.x,node.position.y,node.position.z)>100?0:1000;
          if (score<bestScore) { bestScore=score; found=obj; }
        });
      } catch {}
    }
    __crFly_localMesh=found; __crFly_localNode=found?.parent||null;
    return found;
  }

  function __crFly_hookCamera(cam) {
    if (!cam||cam.__crV10CamHooked) return;
    const orig=cam.updateMatrixWorld.bind(cam);
    cam.updateMatrixWorld=function(force){ __crFly_applyVisualFly(this); return orig(force); };
    cam.__crV10CamHooked=true;
  }

  function __crFly_writeNodeTranslation(node, pos) {
    if (!node||!pos) return;
    node.position.x=pos.x; node.position.y=pos.y; node.position.z=pos.z;
    const m=node.matrix?.elements;
    if (m) { m[12]=pos.x; m[13]=pos.y; m[14]=pos.z; }
    node.matrixWorldNeedsUpdate=true;
  }

  function __crFly_applyVisualFly(cam) {
    if (!flyOn||!__crFly_flyPos) return;
    if (!cam) cam=getCam();
    __crFly_findLocalMesh(); if (!__crFly_localNode) return;
    const phys=__crFly_copyPos(__crFly_localNode.position);
    const dx=__crFly_flyPos.x-phys.x, dy=__crFly_flyPos.y-phys.y, dz=__crFly_flyPos.z-phys.z;
    __crFly_writeNodeTranslation(__crFly_localNode,__crFly_flyPos);
    try { __crFly_localNode.updateMatrixWorld(true); } catch {}
    if (cam) { cam.position.x+=dx; cam.position.y+=dy; cam.position.z+=dz; cam.matrixWorldNeedsUpdate=true; }
  }

  function __crFly_keyValue(code) {
    if (code==='Space') return [' ',32];
    if (code.startsWith('Shift')) return ['Shift',16];
    if (code.startsWith('Control')) return ['Control',17];
    const k=code.replace(/^Key/,'').toLowerCase();
    return [k,k.toUpperCase().charCodeAt(0)];
  }

  function __crFly_releaseGameKeys() {
    const targets=[window,document,document.body,document.querySelector('canvas')].filter(Boolean);
    __crFly_releasingGameKeys=true;
    __crFly_FLY_HELD.forEach(code => {
      const [key,n]=__crFly_keyValue(code);
      targets.forEach(t => {
        const ev=new KeyboardEvent('keyup',{code,key,bubbles:true,cancelable:true});
        try { Object.defineProperty(ev,'keyCode',{get:()=>n}); Object.defineProperty(ev,'which',{get:()=>n}); } catch {}
        t.dispatchEvent(ev);
      });
    });
    __crFly_releasingGameKeys=false;
  }

  function __crFly_norm(v) { const len=Math.hypot(v.x,v.y,v.z); if(!len) return v; v.x/=len; v.y/=len; v.z/=len; return v; }
  function __crFly_addScaled(out,v,s) { out.x+=v.x*s; out.y+=v.y*s; out.z+=v.z*s; }

  function __crFly_updateFly(dt) {
    if (!flyOn||!__crFly_flyPos) return;
    __crFly_findLocalMesh();
    const cam=getCam(); if (cam) __crFly_hookCamera(cam);
    const dir={x:0,y:0,z:0}, mw=cam?.matrixWorld?.elements;
    if (mw) {
      const fwd=__crFly_norm({x:-mw[2],y:0,z:mw[0]}), rgt=__crFly_norm({x:mw[0],y:0,z:mw[2]});
      if (__crFly_flyKeys.has('KeyW')) __crFly_addScaled(dir,fwd,-1);
      if (__crFly_flyKeys.has('KeyS')) __crFly_addScaled(dir,fwd,1);
      if (__crFly_flyKeys.has('KeyD')) __crFly_addScaled(dir,rgt,1);
      if (__crFly_flyKeys.has('KeyA')) __crFly_addScaled(dir,rgt,-1);
    }
    if (__crFly_flyKeys.has('Space')) dir.y+=FLY_VERT/FLY_SPEED;
    if (__crFly_flyKeys.has('ControlLeft')||__crFly_flyKeys.has('ControlRight')) dir.y-=FLY_VERT/FLY_SPEED;
    __crFly_norm(dir);
    const speed=(__crFly_flyKeys.has('ShiftLeft')||__crFly_flyKeys.has('ShiftRight'))?FLY_BOOST:FLY_SPEED;
    __crFly_flyPos.x+=dir.x*speed*dt; __crFly_flyPos.y+=dir.y*speed*dt; __crFly_flyPos.z+=dir.z*speed*dt;
  }

  function __crFly_toggleFly() {
    flyOn=!flyOn; __crFly_flyKeys.clear(); __crFly_releaseGameKeys();
    if (flyOn) {
      __crFly_findLocalMesh();
      const cam=getCam(); if (cam) __crFly_hookCamera(cam);
      if (!__crFly_localNode) { flyOn=false; return; }
      __crFly_flyPos=__crFly_copyPos(__crFly_localNode.position);
      __crFly_applyVisualFly();
    } else {
      __crFly_flyPos=null; __crFly_releaseGameKeys();
    }
  }

  // ─── INPUT ─────────────────────────────────────────────────────────────────
  window.addEventListener('pointerdown', e => { if (e.button===0) _mouseHeld = true; }, true);
  window.addEventListener('pointerup',   e => { if (e.button===0) _mouseHeld = false; }, true);
  window.addEventListener('blur', () => {
    _mouseHeld = false;
    __crFly_flyKeys.clear();
  }, true);

  window.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const isTyping = tag==='INPUT' || tag==='TEXTAREA' || document.activeElement?.isContentEditable;
    if (__crFly_releasingGameKeys) return;
    if (flyOn && __crFly_FLY_HELD.has(e.code) && !isTyping) {
      __crFly_flyKeys.add(e.code); e.preventDefault(); e.stopImmediatePropagation(); return;
    }

    if (isTyping) return;
    if (e.code==='KeyM') { document.getElementById('crp')?.classList.toggle('hidden'); e.stopPropagation(); }
    if (e.code==='KeyT') { espOn=!espOn; updateToggles(); e.stopPropagation(); }
    if (e.code==='KeyF') { setLock(!lockOn); e.stopPropagation(); }
    if (e.code==='KeyR') { setAura(!auraOn); e.stopPropagation(); }

    // Fly hotkeys (from Script A):
    if (e.code==='KeyL' && !e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); __crFly_toggleFly(); __crFly_updateFlyPanel(); return; }
    if (e.code==='KeyK' && !e.repeat) { __crFly_findLocalMesh(); if(__crFly_localNode) __crFly_flyPos=__crFly_copyPos(__crFly_localNode.position); return; }
  }, true);

  window.addEventListener('keyup', e => {
    if (__crFly_releasingGameKeys) return;
    if (__crFly_FLY_HELD.has(e.code)) __crFly_flyKeys.delete(e.code);
    if (flyOn && __crFly_FLY_HELD.has(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ─── UI HELPERS ────────────────────────────────────────────────────────────
  let togEsp, togLock, togAura, togFly;

  function updateToggles() {
    togEsp?.classList.toggle('on', espOn);
    togLock?.classList.toggle('on', lockOn);
    togAura?.classList.toggle('on', auraOn);
    togFly?.classList.toggle('on', flyOn);
  }

  function setLock(v) {
    lockOn = v; if (v) { auraOn=false; }
    if (!v) { _lockTarget=null; _lerpX=0; _lerpY=0; }
    updateToggles();
  }

  function setAura(v) {
    auraOn = v; if (v) { lockOn=false; }
    if (!v) {
      const c = document.querySelector('canvas') || document.body;
      releaseClick(c); _lockTarget=null; _lerpX=0; _lerpY=0;
    }
    updateToggles();
  }

  // minimal fly status updater (adds a small status element into the panel)
  function __crFly_updateFlyPanel() {
    const el = document.getElementById('cr-fly-status');
    if (el) el.textContent = flyOn ? 'ON' : 'OFF';
    updateToggles();
  }

  // ─── LOAD ──────────────────────────────────────────────────────────────────
  window.addEventListener('load', () => {

    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99990;pointer-events:none;';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    const rsz = () => { cv.width=innerWidth; cv.height=innerHeight; };
    rsz(); window.addEventListener('resize', rsz);

    const gameCanvas = document.querySelector('canvas#canvas') || document.querySelector('canvas');

    const panel = document.createElement('div');
    panel.id = 'crp';
    document.body.appendChild(panel);

    document.head.insertAdjacentHTML('beforeend', `<style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
      #crp{position:fixed;top:60px;left:16px;width:230px;background:rgba(6,6,10,0.93);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.06);border-radius:14px;z-index:999999;font-family:'Inter',sans-serif;color:#fff;box-shadow:0 16px 48px rgba(0,0,0,0.8),inset 0 1px 0 rgba(255,255,255,0.04);user-select:none;overflow:hidden;}
      #crp.hidden{display:none;}
      #crp-hdr{padding:13px 15px 11px;display:flex;justify-content:space-between;align-items:center;cursor:grab;border-bottom:1px solid rgba(255,255,255,0.05);}
      #crp-hdr:active{cursor:grabbing;}
      #crp-name{font-size:12px;font-weight:600;}
      #crp-ver{font-size:8px;color:rgba(255,255,255,0.18);letter-spacing:1.8px;margin-top:2px;}
      #crp-x{cursor:pointer;color:rgba(255,255,255,0.18);font-size:18px;line-height:1;transition:color .15s;}
      #crp-x:hover{color:rgba(255,255,255,0.6);}
      #crp-body{padding:13px 15px;}
      .cr-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
      .cr-lbl{font-size:10px;color:rgba(255,255,255,0.4);font-weight:500;display:flex;align-items:center;gap:6px;flex:1;}
      .cr-note{font-size:8px;color:rgba(255,255,255,0.18);font-style:italic;margin-left:4px;}
      .cr-key{font-size:7.5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);padding:1px 5px;border-radius:3px;color:rgba(255,255,255,0.25);font-family:monospace;}
      .cr-tog{position:relative;width:38px;height:20px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;cursor:pointer;transition:all .2s;flex-shrink:0;}
      .cr-tog::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,0.18);transition:all .2s;}
      .cr-tog.on{background:rgba(70,150,255,0.18);border-color:rgba(70,150,255,0.38);}
      .cr-tog.on::after{transform:translateX(18px);background:#4a96ff;}
      .cr-tog.yel.on{background:rgba(255,200,50,0.18);border-color:rgba(255,200,50,0.38);}
      .cr-tog.yel.on::after{background:#ffc832;}
      .cr-tog.red.on{background:rgba(255,45,75,0.18);border-color:rgba(255,45,75,0.38);}
      .cr-tog.red.on::after{background:#ff2d4b;}
      .cr-tog.grn.on{background:rgba(80,220,120,0.18);border-color:rgba(80,220,120,0.38);}
      .cr-tog.grn.on::after{background:#50dc78;}
      .cr-div{height:1px;background:rgba(255,255,255,0.05);margin:10px 0;}
      .cr-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
      .cr-stat{background:rgba(255,255,255,0.028);border:1px solid rgba(255,255,255,0.045);border-radius:9px;padding:8px 10px;}
      .cr-sk{font-size:8px;color:rgba(255,255,255,0.2);text-transform:uppercase;letter-spacing:1.1px;margin-bottom:3px;}
      .cr-sv{font-size:13px;font-weight:600;color:#fff;}
      .cr-sv.blue{color:#4a96ff;} .cr-sv.yel{color:#ffc832;} .cr-sv.red{color:#ff2d4b;} .cr-sv.grn{color:#50dc78;}
      .cr-hint{font-size:7.5px;color:rgba(255,255,255,0.12);text-align:center;margin-top:10px;letter-spacing:.5px;}
      .cr-fly-info{font-size:8.5px;color:rgba(255,255,255,0.25);margin-top:8px;line-height:1.6;}
      .cr-fly-info span{color:rgba(255,255,255,0.45);}
      .cr-slider{ margin-bottom:10px; }
      .cr-slider label{ display:flex; justify-content:space-between; font-size:10px; color:rgba(255,255,255,0.45); margin-bottom:4px; }
      .cr-slider input{ width:100%; }
      .cr-playerbox{ margin-top:10px; background:rgba(255,255,255,0.025); border:1px solid rgba(255,255,255,0.05); border-radius:10px; overflow:hidden; }
      .cr-playerhdr{ font-size:9px; letter-spacing:1px; color:rgba(255,255,255,0.28); padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.04); }
      #cr-players{ max-height:180px; overflow-y:auto; }
      .cr-player{ display:flex; align-items:center; justify-content:space-between; padding:7px 9px; border-bottom:1px solid rgba(255,255,255,0.03); }
      .cr-player:last-child{ border-bottom:none; }
      .cr-player-id{ font-size:10px; color:white; }
      .cr-player-btns{ display:flex; gap:5px; }
      .cr-btn{ border:none; cursor:pointer; border-radius:5px; font-size:9px; padding:3px 6px; color:white; background:rgba(255,255,255,0.08); }
      .cr-btn.friend{ background:rgba(80,220,120,0.18); }
      .cr-btn.prio{ background:rgba(255,200,50,0.18); }
      .cr-player-row{ display:flex; align-items:center; justify-content:space-between; padding:7px 9px; border-bottom:1px solid rgba(255,255,255,0.03); }
      .cr-player-left{ display:flex; align-items:center; gap:6px; }
      .cr-player-actions{ display:flex; gap:5px; }
      .cr-player-empty{ padding:10px; text-align:center; font-size:9px; color:rgba(255,255,255,0.25); }
      .cr-btn.active{ outline:1px solid rgba(255,255,255,0.25); }
    </style>`);

    panel.innerHTML = `
      <div id="crp-hdr">
        <div><div id="crp-name">CubeRealm v10</div><div id="crp-ver">ESP · LOCK · AURA · FLY</div></div>
        <span id="crp-x">×</span>
      </div>
      <div id="crp-body">
        <div class="cr-row">
          <span class="cr-lbl">Skeleton ESP <span class="cr-key">T</span></span>
          <div class="cr-tog on" id="cr-esp"></div>
        </div>
        <div class="cr-row">
          <span class="cr-lbl">Lock-On <span class="cr-key">F</span></span>
          <div class="cr-tog yel" id="cr-lock"></div>
        </div>
        <div class="cr-row">
          <span class="cr-lbl">Kill Aura <span class="cr-key">R</span></span>
          <div class="cr-tog red" id="cr-aura"></div>
        </div>
        <div class="cr-row">
          <span class="cr-lbl">Fly <span class="cr-key">L</span> <span class="cr-note">visual only</span></span>
          <div class="cr-tog grn" id="cr-fly"></div>
        </div>
        <div class="cr-div"></div>
        <div class="cr-grid">
          <div class="cr-stat"><div class="cr-sk">Players</div><div class="cr-sv" id="cr-pl">0</div></div>
          <div class="cr-stat"><div class="cr-sk">Target</div><div class="cr-sv" id="cr-tg">—</div></div>
          <div class="cr-stat"><div class="cr-sk">Range</div><div class="cr-sv">${AURA_RANGE}u</div></div>
          <div class="cr-stat"><div class="cr-sk">Mode</div><div class="cr-sv" id="cr-md">OFF</div></div>
        </div>
        <div class="cr-div"></div>

<div class="cr-playerbox">
  <div class="cr-playerhdr">
    PLAYERS
  </div>

  <div id="cr-players"></div>
</div>
        <div class="cr-hint">M panel · T esp · F lock · R aura · L fly</div>
        <div class="cr-div"></div>

<div class="cr-slider">
  <label>Lock Gain <span id="gain-v">0.30</span></label>
  <input id="gain-s" type="range" min="0.05" max="1" step="0.01" value="0.30">
</div>

<div class="cr-slider">
  <label>Max PX <span id="max-v">50</span></label>
  <input id="max-s" type="range" min="5" max="200" step="1" value="50">
</div>

<div class="cr-slider">
  <label>Smooth <span id="smooth-v">0.35</span></label>
  <input id="smooth-s" type="range" min="0.01" max="1" step="0.01" value="0.35">
</div>

<div class="cr-slider">
  <label>Aura Range <span id="range-v">8</span></label>
  <input id="range-s" type="range" min="1" max="20" step="0.5" value="8">
</div>

<div class="cr-fly-info">Fly: <span id="cr-fly-status">OFF</span></div>
      </div>`;

    // Grab toggles
    togEsp  = panel.querySelector('#cr-esp');
    togLock = panel.querySelector('#cr-lock');
    togAura = panel.querySelector('#cr-aura');
    togFly  = panel.querySelector('#cr-fly');
    const elPl = panel.querySelector('#cr-pl');
    const elTg = panel.querySelector('#cr-tg');
    const elMd = panel.querySelector('#cr-md');
    const playersEl = panel.querySelector('#cr-players');

    const gainS   = panel.querySelector('#gain-s');
    const maxS    = panel.querySelector('#max-s');
    const smoothS = panel.querySelector('#smooth-s');
    const rangeS  = panel.querySelector('#range-s');

    gainS.oninput = () => {
      LOCK_GAIN = parseFloat(gainS.value);
      panel.querySelector('#gain-v').textContent = LOCK_GAIN.toFixed(2);
    };

    maxS.oninput = () => {
      LOCK_MAX_PX = parseFloat(maxS.value);
      panel.querySelector('#max-v').textContent = LOCK_MAX_PX;
    };

    smoothS.oninput = () => {
      LERP_SMOOTH = parseFloat(smoothS.value);
      panel.querySelector('#smooth-v').textContent = LERP_SMOOTH.toFixed(2);
    };

    rangeS.oninput = () => {
      AURA_RANGE = parseFloat(rangeS.value);
      panel.querySelector('#range-v').textContent = AURA_RANGE.toFixed(1);
    };

    togEsp.addEventListener('click',  () => { espOn=!espOn; updateToggles(); });
    togLock.addEventListener('click', () => setLock(!lockOn));
    togAura.addEventListener('click', () => setAura(!auraOn));
    togFly.addEventListener('click',  () => { __crFly_toggleFly(); __crFly_updateFlyPanel(); });
    panel.querySelector('#crp-x').addEventListener('click', () => panel.classList.add('hidden'));

    // Drag
    let drag=false, ox=0, oy=0;
    panel.querySelector('#crp-hdr').addEventListener('mousedown', e => {
      drag=true; ox=e.clientX-panel.offsetLeft; oy=e.clientY-panel.offsetTop; e.preventDefault();
    });
    document.addEventListener('mousemove', e => { if(drag){panel.style.left=(e.clientX-ox)+'px';panel.style.top=(e.clientY-oy)+'px';} });
    document.addEventListener('mouseup', () => drag=false);

    let _lastPlayersHash = '';

    function updatePlayerList(players) {

      const hash = players.map(p =>
        `${p.id}:${FRIENDS.has(p.id)}:${PRIORITY.has(p.id)}`
      ).join('|');

      if (hash === _lastPlayersHash) return;
      _lastPlayersHash = hash;

      const list = document.getElementById('cr-players');
      if (!list) return;

      list.innerHTML = '';

      players.forEach(p => {

        const row = document.createElement('div');
        row.className = 'cr-player-row';

        const left = document.createElement('div');
        left.className = 'cr-player-left';

        const id = document.createElement('div');
        id.className = 'cr-player-id';

        const isFriend   = FRIENDS.has(p.id);
        const isPriority = PRIORITY.has(p.id);

        id.textContent =
          `#${p.id}` +
          (isFriend ? ' [ALLY]' : '') +
          (isPriority ? ' [TARGET]' : '');

        left.appendChild(id);

        const actions = document.createElement('div');
        actions.className = 'cr-player-actions';

        // ALLY
        const allyBtn = document.createElement('button');
        allyBtn.className = 'cr-btn';

        allyBtn.textContent = isFriend
          ? 'Remove Ally'
          : 'Add Ally';

        if (isFriend)
          allyBtn.classList.add('active');

        allyBtn.onclick = (e) => {

          e.stopPropagation();

          if (FRIENDS.has(p.id)) {
            FRIENDS.delete(p.id);
          } else {
            FRIENDS.add(p.id);
            PRIORITY.delete(p.id);
          }

          _lastPlayersHash = '';
          updatePlayerList(players);
        };

        // PRIORITY
        const prioBtn = document.createElement('button');
        prioBtn.className = 'cr-btn red';

        prioBtn.textContent = isPriority
          ? 'Remove Target'
          : 'Priority';

        if (isPriority)
          prioBtn.classList.add('active');

        prioBtn.onclick = (e) => {

          e.stopPropagation();

          if (PRIORITY.has(p.id)) {
            PRIORITY.delete(p.id);
          } else {
            PRIORITY.add(p.id);
            FRIENDS.delete(p.id);
          }

          _lastPlayersHash = '';
          updatePlayerList(players);
        };

        actions.appendChild(allyBtn);
        actions.appendChild(prioBtn);

        row.appendChild(left);
        row.appendChild(actions);

        list.appendChild(row);
      });

      if (!players.length) {
        list.innerHTML =
          '<div class="cr-player-empty">no players detected</div>';
      }
    }

    // ─── RAF ─────────────────────────────────────────────────────────────────
    const _raf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      return _raf.call(window, t => {
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
        lastFrame = now;

        const scene   = getScene();
        const cam     = getCam();
        const W = cv.width, H = cv.height;
        const players = cam && scene ? getPlayers(scene) : [];
        const canvas  = gameCanvas || document.querySelector('canvas') || document.body;

        // Update fly each frame
        __crFly_updateFly(dt);

        // Aim/aura
        if (cam && players.length) {
          if (lockOn)      doLockOn(players, cam, canvas, W, H);
          else if (auraOn) doAura(players, cam, canvas, W, H);
        }
        if (!lockOn && !auraOn) { _lockTarget=null; _lerpX=0; _lerpY=0; }

        const result = cb(t);

        // Apply visual fly modifications after frame update (so camera/node transforms persist visually)
        __crFly_applyVisualFly(cam);

        // ─── DRAW ────────────────────────────────────────────────────
        ctx.clearRect(0, 0, W, H);
        const camOk = cam && !(cam.matrixWorldInverse?.elements[0]===1 && cam.matrixWorldInverse?.elements[5]===1);

        // Status bar
        ctx.font = '9px monospace';
        ctx.fillStyle = camOk ? 'rgba(255,255,255,0.22)' : 'rgba(255,60,60,0.8)';
        const modeStr = auraOn ? 'aura' : lockOn ? 'lock': flyOn ? 'fly' : 'off';
        ctx.fillText(camOk
          ? `v10  players:${players.length}  mode:${modeStr}  target:${_lockTarget ? '🔒' : (lockOn||auraOn)?'scan':'—'}`
          : 'v10  cam:waiting', 6, 14);

        // Panel stats
        elPl.textContent = players.length;
        if (performance.now() % 500 < 16) {
          updatePlayerList(players);
        }
        if (_lockTarget && cam) {
          const live = players.find(p => p.id === _lockTarget.id);
          if (live) {
            const d = Math.hypot(live.pos.x-cam.position.x, live.pos.y-cam.position.y, live.pos.z-cam.position.z);
            elTg.textContent = `${d.toFixed(1)}m`; elTg.className = 'cr-sv '+(auraOn?'red':'yel');
            elMd.textContent = auraOn?'AURA':'LOCK'; elMd.className = 'cr-sv '+(auraOn?'red':'yel');
          } else {
            elTg.textContent='—'; elTg.className='cr-sv'; elMd.textContent='SCAN'; elMd.className='cr-sv blue';
          }
        } else {
          elTg.textContent='—'; elTg.className='cr-sv';
          elMd.textContent = auraOn||lockOn?'SCAN':'OFF';
          elMd.className = 'cr-sv'+(flyOn?' grn':auraOn||lockOn?' blue':'');
        }

        if (!espOn || !cam || !camOk) return result;

        const cx = W/2, cy = H/2;
        players.forEach(p => {
          const isTarget = _lockTarget && p.id === _lockTarget.id;
          const dist = Math.hypot(p.pos.x-cam.position.x, p.pos.y-cam.position.y, p.pos.z-cam.position.z);
          const sb = {};
          Object.entries(p.bones).forEach(([name, bp]) => {
            const s = w2s(bp.x, bp.y, bp.z, cam, W, H); if (s) sb[name] = s;
          });
          if (!sb['Head'] && !sb['Upper']) return;
          const isFriend = FRIENDS.has(p.id);
          const isPrio = PRIORITY.has(p.id);

          const skelRgb =
            isFriend
              ? '80,255,120'
              : isPrio
                ? '255,180,50'
                : isTarget
                  ? (auraOn ? '255,45,75' : '255,200,50')
                  : '75,195,255';

          // Lines
          ctx.save();
          ctx.lineWidth = isTarget?2:1.5;
          ctx.strokeStyle = `rgba(${skelRgb},${isTarget?0.92:0.75})`;
          ctx.shadowColor = `rgba(${skelRgb},0.5)`; ctx.shadowBlur = isTarget?10:4;
          SKEL.forEach(([a,b]) => {
            if (!sb[a]||!sb[b]) return;
            ctx.beginPath(); ctx.moveTo(sb[a].x,sb[a].y); ctx.lineTo(sb[b].x,sb[b].y); ctx.stroke();
          });
          ctx.restore();

          // Joints
          Object.entries(sb).forEach(([name,s]) => {
            const j = JOINT[name]||{r:2,rgb:'180,180,180'}, col = isTarget?skelRgb:j.rgb;
            ctx.save();
            ctx.fillStyle=`rgb(${col})`; ctx.shadowColor=`rgb(${col})`; ctx.shadowBlur=isTarget?14:6;
            ctx.beginPath(); ctx.arc(s.x,s.y,isTarget?j.r*1.35:j.r,0,Math.PI*2); ctx.fill();
            ctx.restore();
          });

         // Distance + ID
          if (sb['Head']) {

            const txt = `#${p.id} • ${dist.toFixed(1)}m`;

            ctx.save();
            ctx.font = '500 9px Inter,sans-serif';
            ctx.textAlign = 'center';

            const metrics = ctx.measureText(txt);
            const padX = 6;
            const padY = 3;

            const x = sb['Head'].x;
            const y = sb['Head'].y - 18;

            const w = metrics.width + padX * 2;
            const h = 14;

            // Background
            ctx.fillStyle = 'rgba(0,0,0,0.45)';

            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(x - w / 2, y - h + 3, w, h, 4);
            } else {
              // fallback rectangle
              ctx.rect(x - w / 2, y - h + 3, w, h);
            }
            ctx.fill();

            // Text
            ctx.fillStyle = isTarget
              ? `rgba(${skelRgb},0.98)`
              : 'rgba(255,255,255,0.92)';

            ctx.fillText(txt, x, y);

            ctx.restore();
          }
          // Target bracket
          if (isTarget && sb['Head']) {
            const hp=sb['Head'], sz=18;
            ctx.save(); ctx.strokeStyle=`rgba(${skelRgb},0.95)`; ctx.lineWidth=1.8;
            ctx.shadowColor=`rgb(${skelRgb})`; ctx.shadowBlur=12;
            [[-1,-1],[1,-1],[1,1],[-1,1]].forEach(([sx,sy]) => {
              ctx.beginPath();
              ctx.moveTo(hp.x+sx*sz, hp.y+sy*(sz*0.4)); ctx.lineTo(hp.x+sx*sz, hp.y+sy*sz); ctx.lineTo(hp.x+sx*(sz*0.4), hp.y+sy*sz);
              ctx.stroke();
            });
            ctx.restore();
          }

          // Tracer
          const aimPt = sb['Head']||sb['Upper'];
          if (aimPt) {
            ctx.save();
            ctx.strokeStyle=isTarget?`rgba(${skelRgb},0.32)`:'rgba(255,255,255,0.08)';
            ctx.lineWidth=isTarget?1.2:0.6; ctx.setLineDash(isTarget?[]:[3,8]);
            ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(aimPt.x,aimPt.y); ctx.stroke();
            ctx.restore();
          }
        });

        return result;
      });
    };
    updateToggles();
    __crFly_updateFlyPanel();
    console.log('[v10.3.1 - Merged with Script A] ready — T=esp  F=lock  R=aura  L=fly(visual)  M=panel');
  });

})();
