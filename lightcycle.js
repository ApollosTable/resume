// TRON Light Cycle Trail + Click Burst
// Draws right-angle trails that follow the mouse and burst rings on click
(function(){
  const canvas = document.createElement('canvas');
  canvas.id = 'lc';
  canvas.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  function resize(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  // --- TRAIL ---
  const trail = [];          // {x,y,age}
  const maxTrail = 80;
  const trailLife = 1.2;     // seconds to fade
  let lastX = -1, lastY = -1;
  let dirX = true;           // current axis: true=horizontal, false=vertical
  let cornerX = -1, cornerY = -1;
  let active = false;
  let idleTimer = 0;

  function addSegment(x1, y1, x2, y2) {
    // Break a line into trail points
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const steps = Math.max(1, Math.floor(dist / 3));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      trail.push({ x: x1 + dx*t, y: y1 + dy*t, age: 0 });
      if (trail.length > maxTrail * 3) trail.shift();
    }
  }

  document.addEventListener('mousemove', function(e) {
    const mx = e.clientX, my = e.clientY;
    active = true;
    idleTimer = 0;

    if (lastX < 0) {
      lastX = mx; lastY = my;
      cornerX = mx; cornerY = my;
      return;
    }

    const dx = Math.abs(mx - cornerX);
    const dy = Math.abs(my - cornerY);

    // Decide when to turn — every 30px of movement on the off-axis
    if (dirX && dy > 25) {
      // Lay horizontal segment to corner, then switch to vertical
      addSegment(lastX, lastY, mx, cornerY);
      lastX = mx; lastY = cornerY;
      cornerX = mx; cornerY = cornerY;
      dirX = false;
    } else if (!dirX && dx > 25) {
      // Lay vertical segment to corner, then switch to horizontal
      addSegment(lastX, lastY, cornerX, my);
      lastX = cornerX; lastY = my;
      cornerX = cornerX; cornerY = my;
      dirX = true;
    }

    // Continue current direction
    if (dirX) {
      addSegment(lastX, lastY, mx, lastY);
      lastX = mx;
      cornerX = mx;
    } else {
      addSegment(lastX, lastY, lastX, my);
      lastY = my;
      cornerY = my;
    }
  });

  // --- CLICK BURSTS ---
  const bursts = []; // {x, y, age, maxAge}

  document.addEventListener('click', function(e) {
    bursts.push({ x: e.clientX, y: e.clientY, age: 0, maxAge: 0.6 });
    // Also push a second slower ring
    bursts.push({ x: e.clientX, y: e.clientY, age: -0.08, maxAge: 0.7 });
  });

  // --- RENDER ---
  let last = performance.now();

  function draw(now) {
    const dt = (now - last) / 1000;
    last = now;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Age + idle detection
    idleTimer += dt;
    if (idleTimer > 0.3) active = false;

    // Draw trail
    for (let i = trail.length - 1; i >= 0; i--) {
      trail[i].age += dt;
      if (trail[i].age > trailLife) { trail.splice(i, 1); continue; }
    }

    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const p = trail[i-1], c = trail[i];
        const alpha = Math.max(0, 1 - c.age / trailLife) * 0.4;
        if (alpha <= 0) continue;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(c.x, c.y);
        ctx.strokeStyle = `rgba(0,212,255,${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Bright head
      if (active && trail.length > 0) {
        const head = trail[trail.length - 1];
        const ha = Math.max(0, 1 - head.age / trailLife);
        if (ha > 0) {
          ctx.beginPath();
          ctx.arc(head.x, head.y, 2, 0, Math.PI*2);
          ctx.fillStyle = `rgba(0,212,255,${ha * 0.8})`;
          ctx.fill();
          // Glow
          ctx.beginPath();
          ctx.arc(head.x, head.y, 6, 0, Math.PI*2);
          const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 6);
          g.addColorStop(0, `rgba(0,212,255,${ha * 0.3})`);
          g.addColorStop(1, 'rgba(0,212,255,0)');
          ctx.fillStyle = g;
          ctx.fill();
        }
      }
    }

    // Draw click bursts — expanding diamond/ring
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.age += dt;
      if (b.age > b.maxAge) { bursts.splice(i, 1); continue; }
      if (b.age < 0) continue; // delayed start

      const progress = b.age / b.maxAge;
      const alpha = (1 - progress) * 0.5;
      const radius = progress * 50;

      // Diamond shape (rotated square) — very TRON
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.rect(-radius, -radius, radius*2, radius*2);
      ctx.strokeStyle = `rgba(0,212,255,${alpha})`;
      ctx.lineWidth = 1.5 * (1 - progress);
      ctx.stroke();
      ctx.restore();

      // Inner dot flash
      if (progress < 0.2) {
        const da = (1 - progress/0.2) * 0.6;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 3 * (1 - progress/0.2), 0, Math.PI*2);
        ctx.fillStyle = `rgba(0,212,255,${da})`;
        ctx.fill();
      }
    }

    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
})();
