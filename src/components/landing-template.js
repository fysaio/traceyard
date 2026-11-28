/* global window, document, navigator, ResizeObserver, IntersectionObserver, performance */

(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let prefersReducedMotion = motionQuery.matches;

  /* -----------------------------------------------------------
   * 1. Contract Payloads (Terminal, MCP JSON, .traceyard.yml)
   * ----------------------------------------------------------- */
  const CONTRACTS = {
    terminal: {
      fileLabel: "traceyard watch --change",
      caption:
        "Illustrative target contract — Separates fast local feedback from final commit-bound policy proof.",
      raw: `Traceyard  payments-api  feat/retry-policy
Working tree: 6 changed paths  |  Context: issue #842 (user-linked)
State: VERIFYING  |  Final contribution proof: PENDING

Plan
  ✓ Format and type-check              passed · 4s
  ● Retry unit tests                    running · 18/42
  ○ Payments package checks             queued
  ○ Required PR checks                  wait for final candidate
  – Full repository suite               not run · not required by current policy

Latest result
  retry.test.ts / retries after 429     FAILED
  Expected 3 attempts; received 2
  Evidence: run trv_01J9K… · working tree fingerprint 8a4c9f…

The coding agent was notified. Results from this run will become stale if relevant files change.`,
    },
    mcp: {
      fileLabel: 'schema_version: "1"',
      caption:
        "Illustrative target contract — Bounded common response envelope returned to coding agents over MCP or CLI.",
      raw: `{
  "schema_version": "1",
  "state": "RUNNING",
  "claim": "FAST_SIGNAL_PENDING",
  "repository": { "id": "repo_123", "name": "org/payments-api" },
  "change": {
    "base_sha": "7f3a91c",
    "candidate_sha": null,
    "worktree_fingerprint": "sha256:8a4c9f…",
    "scope_complete": false,
    "unknowns": ["generated API clients are not indexed"]
  },
  "context_refs": [{ "kind": "issue", "id": "842", "association": "EXPLICIT" }],
  "plan_id": "plan_01J9K…",
  "policy_version": "policy:17",
  "checks_run": [{ "id": "retry-unit", "state": "RUNNING" }],
  "checks_omitted": [{ "id": "full-suite", "reason": "not required by current policy" }],
  "risk_reasons": [],
  "trust_level": "LOCAL_PROVISIONAL",
  "evidence_ids": [],
  "limitations": ["Working-tree result is provisional until committed"],
  "human_action": null,
  "next_action": "inspect_run"
}`,
    },
    policy: {
      fileLabel: ".traceyard.yml",
      caption:
        "Illustrative target contract — Maintainer-owned repository policy controlling checkpoints, isolation, and escalation.",
      raw: `version: 1

agent_workflow:
  enabled: true
  automatic_discovery: true
  checkpoints: [session_start, after_change, before_submit]
  allow_local_working_tree_results: true

execution:
  default_mode: local
  network: deny
  require_approval_for:
    - dependency_install
    - external_service
    - secrets
    - destructive_check
  max_parallel_checks: 2

checks:
  - id: format
    adapter: npm_script
    script: format:check
    phase: fast
    required_for: [pull_request]
    timeout_seconds: 120
    auto_run: true

  - id: unit
    adapter: npm_script
    script: test:unit
    phase: affected_package
    required_for: [pull_request]
    timeout_seconds: 900
    auto_run: true

  - id: integration
    adapter: declared_command
    argv: ["./scripts/test-integration"]
    working_directory: "."
    phase: integration
    required_for: [pull_request]
    timeout_seconds: 1800
    network: deny
    auto_run: false

escalation:
  on_unknown_scope: widen_or_review
  on_changed_test_inputs: review
  on_required_check_unavailable: blocked
  on_unlinked_intent: annotate`,
    },
  };

  const createSpan = (text, cls) => {
    const span = document.createElement("span");
    span.textContent = text;
    if (cls) span.className = cls;
    return span;
  };

  // Safely populate syntax-colored MCP JSON using DOM nodes (no raw innerHTML)
  const mcpSlot = document.getElementById("mcpCodeSlot");
  if (mcpSlot) {
    CONTRACTS.mcp.raw.split("\n").forEach((line) => {
      const row = document.createElement("div");
      const m = line.match(/^(\s*)"([^"]+)":\s*(.*)$/);
      if (!m) {
        row.className = "t-dim";
        row.textContent = line;
      } else {
        const [, indent, key, rest] = m;
        let valCls = "";
        if (rest.startsWith('"')) valCls = "t-sky";
        if (rest.startsWith("false") || rest.startsWith("true") || rest.startsWith("null"))
          valCls = "t-amber";
        if (key === "trust_level" || key === "claim") valCls = "t-blue";
        if (key === "unknowns" || key === "limitations") valCls = "t-gold";
        row.append(
          createSpan(indent),
          createSpan(`"${key}"`, "t-white"),
          createSpan(": ", "t-dim"),
          createSpan(rest, valCls),
        );
      }
      mcpSlot.appendChild(row);
    });
  }

  // Safely populate syntax-colored .traceyard.yml using DOM nodes
  const policySlot = document.getElementById("policyCodeSlot");
  if (policySlot) {
    CONTRACTS.policy.raw.split("\n").forEach((line) => {
      const row = document.createElement("div");
      if (!line.trim()) {
        row.style.height = "12px";
        policySlot.appendChild(row);
        return;
      }
      const listMatch = line.match(/^(\s*-\s+)(.*)$/);
      if (listMatch) {
        const [, bullet, rest] = listMatch;
        const kv = rest.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
        if (kv) {
          row.append(
            createSpan(bullet, "t-blue"),
            createSpan(kv[1], "t-white"),
            createSpan(": ", "t-dim"),
            createSpan(kv[2], "t-sky"),
          );
        } else {
          row.append(createSpan(bullet, "t-blue"), createSpan(rest, "t-gold"));
        }
        policySlot.appendChild(row);
        return;
      }
      const kvMatch = line.match(/^(\s*)([a-zA-Z0-9_]+):(.*)$/);
      if (kvMatch) {
        const [, indent, key, rest] = kvMatch;
        const trimmed = rest.trim();
        const isPrimitive =
          trimmed === "true" || trimmed === "false" || trimmed === "deny" || /^\d+$/.test(trimmed);
        const keySpan = createSpan(key, indent.length === 0 ? "t-blue" : "t-white");
        if (indent.length === 0) keySpan.style.fontWeight = "500";
        row.append(
          createSpan(indent),
          keySpan,
          createSpan(":", "t-dim"),
          createSpan(rest, isPrimitive ? "t-emerald" : "t-sky"),
        );
      } else {
        row.textContent = line;
      }
      policySlot.appendChild(row);
    });
  }

  /* -----------------------------------------------------------
   * 2. Mobile Navigation Drawer
   * ----------------------------------------------------------- */
  const menuBtn = document.getElementById("mobileMenuBtn");
  const mobileDrawer = document.getElementById("mobileDrawer");
  const iconOpen = document.getElementById("menuIconOpen");
  const iconClose = document.getElementById("menuIconClose");

  const setDrawer = (open) => {
    if (!menuBtn || !mobileDrawer) return;
    mobileDrawer.classList.toggle("is-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
    if (iconOpen) iconOpen.style.display = open ? "none" : "inline-block";
    if (iconClose) iconClose.style.display = open ? "inline-block" : "none";
  };

  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      setDrawer(!mobileDrawer.classList.contains("is-open"));
    });
  }

  document.querySelectorAll(".mobile-nav-link").forEach((link) => {
    link.addEventListener("click", () => setDrawer(false));
  });

  /* -----------------------------------------------------------
   * 3. Technical Contract Tabs & Clipboard Copy
   * ----------------------------------------------------------- */
  let activeTab = "terminal";
  const tabButtons = document.querySelectorAll(".tab-btn");
  const fileLabelEl = document.getElementById("activeFileLabel");
  const captionEl = document.getElementById("activeCaptionText");
  const copySnippetBtn = document.getElementById("copySnippetBtn");

  const flashCopyButton = (btn) => {
    const idle = btn.querySelector(".copy-icon-idle");
    const done = btn.querySelector(".copy-icon-done");
    const label = btn.querySelector(".copy-label");
    if (idle) idle.style.display = "none";
    if (done) done.style.display = "inline-block";
    if (label) label.textContent = "Copied";
    window.clearTimeout(btn._copyTimer);
    btn._copyTimer = window.setTimeout(() => {
      if (idle) idle.style.display = "inline-block";
      if (done) done.style.display = "none";
      if (label) label.textContent = "Copy";
    }, 2000);
  };

  const copyToClipboard = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopyButton(btn);
    } catch {
      // Fallback for restricted clipboard contexts
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        flashCopyButton(btn);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.tab;
      if (!next || !CONTRACTS[next]) return;
      activeTab = next;
      tabButtons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === next)));
      document.querySelectorAll(".terminal-panel").forEach((panel) => {
        panel.classList.toggle("is-active", panel.id === `panel-${next}`);
      });
      if (fileLabelEl) fileLabelEl.textContent = CONTRACTS[next].fileLabel;
      if (captionEl) captionEl.textContent = CONTRACTS[next].caption;
    });
  });

  if (copySnippetBtn) {
    copySnippetBtn.addEventListener("click", () => {
      copyToClipboard(CONTRACTS[activeTab].raw, copySnippetBtn);
    });
  }

  document.querySelectorAll("[data-copy-text]").forEach((btn) => {
    btn.addEventListener("click", () => {
      copyToClipboard(btn.getAttribute("data-copy-text") || "", btn);
    });
  });

  /* -----------------------------------------------------------
   * 4. Procedural SVG Pixel-Staircase Wave Dividers
   * ----------------------------------------------------------- */
  const buildPixelWave = (container) => {
    const topColor = container.dataset.waveTop || "#FFFFFF";
    const bottomColor = container.dataset.waveBottom || "#0033FF";
    container.style.backgroundColor = topColor;

    const cols = 48;
    const rows = 9;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${cols} ${rows}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("shape-rendering", "crispEdges");

    for (let x = 0; x < cols; x++) {
      const wave =
        Math.sin((x / cols) * Math.PI * 4.5 + 0.4) * 1.65 +
        Math.cos((x / cols) * Math.PI * 9.0) * 0.85;
      const baseHeight = Math.max(2, Math.min(rows - 2, Math.round(4.2 + wave)));

      for (let y = 0; y < rows; y++) {
        const dist = rows - 1 - y;
        let draw = false;
        if (dist < baseHeight - 1) draw = true;
        else if (dist === baseHeight - 1 && ((x + y) % 2 === 0 || x % 5 === 0)) draw = true;
        else if (dist === baseHeight && (x * 7 + y * 3) % 4 === 0) draw = true;
        else if (dist === baseHeight + 1 && (x * 11 + 5) % 9 === 0) draw = true;

        if (draw) {
          const rect = document.createElementNS(SVG_NS, "rect");
          rect.setAttribute("x", String(x));
          rect.setAttribute("y", String(y));
          rect.setAttribute("width", "1.02");
          rect.setAttribute("height", "1.02");
          rect.setAttribute("fill", bottomColor);
          svg.appendChild(rect);
        }
      }
    }
    container.appendChild(svg);
  };

  document.querySelectorAll("[data-wave-top]").forEach(buildPixelWave);

  /* -----------------------------------------------------------
   * 5. Procedural SVG Swiss Dot-Matrix Diagrams
   * ----------------------------------------------------------- */
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };

  const buildDotMatrix = (container) => {
    const variant = container.dataset.dotMatrix;
    if (variant === "signal-stairs") {
      const cols = 22,
        rows = 9;
      const curve = [1, 1, 2, 2, 3, 2, 3, 3, 4, 5, 4, 5, 5, 6, 6, 5, 6, 7, 7, 8, 8, 8];
      const svg = svgEl("svg", { viewBox: "0 0 264 108", class: "dot-svg" });
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const level = rows - 1 - r;
          const target = curve[c];
          const isFast = c < 10;
          let fill = "#E2E6F0";
          let radius = 1.6;
          if (level === target) {
            fill = isFast ? "#3B66FF" : "#0033FF";
            radius = 2.7;
          } else if (level < target) {
            fill = isFast ? "#C7D6FF" : "#809DFF";
            radius = 1.9;
          }
          svg.appendChild(svgEl("circle", { cx: 6 + c * 12, cy: 6 + r * 12, r: radius, fill }));
        }
      }
      svg.appendChild(
        svgEl("line", {
          x1: 120,
          y1: 2,
          x2: 120,
          y2: 106,
          stroke: "#111318",
          "stroke-width": 1,
          "stroke-dasharray": "2 3",
          opacity: 0.35,
        }),
      );
      container.appendChild(svg);
    } else if (variant === "state-matrix") {
      const cols = 22,
        rows = 6;
      const hi = {
        "1-3": "#3B82F6",
        "1-4": "#3B82F6",
        "2-8": "#00B86B",
        "2-9": "#00B86B",
        "3-13": "#F59E0B",
        "3-14": "#F59E0B",
        "4-18": "#F43F5E",
        "2-19": "#0033FF",
        "1-16": "#00B86B",
      };
      const svg = svgEl("svg", { viewBox: "0 0 264 72", class: "dot-svg" });
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const accent = hi[`${r}-${c}`];
          const sz = accent ? 4.5 : 2.5;
          svg.appendChild(
            svgEl("rect", {
              x: 4 + c * 12,
              y: 4 + r * 12,
              width: sz,
              height: sz,
              fill: accent || "rgba(255,255,255,0.16)",
            }),
          );
        }
      }
      container.appendChild(svg);
    } else if (variant === "crosshair-grid") {
      const cols = 20,
        rows = 8;
      const svg = svgEl("svg", { viewBox: "0 0 240 96", class: "dot-svg" });
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const inCross =
            ((c === 9 || c === 10) && r >= 2 && r <= 5) ||
            ((r === 3 || r === 4) && c >= 7 && c <= 12);
          if (!inCross) {
            svg.appendChild(
              svgEl("circle", {
                cx: 6 + c * 12,
                cy: 6 + r * 12,
                r: 1.7,
                fill: "rgba(255,255,255,0.68)",
              }),
            );
          }
        }
      }
      container.appendChild(svg);
    } else if (variant === "boundary-field") {
      const cols = 22,
        rows = 7;
      const svg = svgEl("svg", { viewBox: "0 0 264 84", class: "dot-svg" });
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (c === 10 || c === 11) continue;
          const isLeft = c < 10;
          const isHi = isLeft ? (r + c) % 5 === 0 : (r * 3 + c) % 4 === 0;
          const sz = isHi ? 4 : 2.5;
          const fill = isLeft ? (isHi ? "#111318" : "#CBD5E1") : isHi ? "#0033FF" : "#BFDBFE";
          svg.appendChild(
            svgEl("rect", { x: 4 + c * 12, y: 4 + r * 12, width: sz, height: sz, fill }),
          );
        }
      }
      svg.appendChild(
        svgEl("line", {
          x1: 131,
          y1: 4,
          x2: 131,
          y2: 80,
          stroke: "#0033FF",
          "stroke-width": 1.5,
          "stroke-dasharray": "3 3",
        }),
      );
      container.appendChild(svg);
    }
  };

  document.querySelectorAll("[data-dot-matrix]").forEach(buildDotMatrix);

  /* -----------------------------------------------------------
   * 6. 60fps Procedural Bayer-Dithered Pixel Blob Canvas
   * ----------------------------------------------------------- */
  const canvas = document.getElementById("pixelBlobCanvas");
  if (canvas) {
    const ctx = canvas.getContext("2d", { alpha: true });
    const BAYER = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    let width = 0;
    let height = 0;
    let isVisible = true;
    let rafId = null;

    // Subtle pointer attraction over the hero stage (zero box, smooth decay)
    const pointer = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5, active: 0, targetActive: 0 };
    const heroRegion = document.getElementById("heroSection");
    if (heroRegion) {
      heroRegion.addEventListener(
        "pointermove",
        (ev) => {
          if (prefersReducedMotion || ev.pointerType === "touch") return;
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const nx = (ev.clientX - rect.left) / rect.width;
          const ny = (ev.clientY - rect.top) / rect.height;
          if (nx >= -0.25 && nx <= 1.25 && ny >= -0.25 && ny <= 1.25) {
            pointer.targetX = Math.max(0, Math.min(1, nx));
            pointer.targetY = Math.max(0, Math.min(1, ny));
            pointer.targetActive = 1;
          } else {
            pointer.targetActive = 0;
          }
        },
        { passive: true },
      );
      heroRegion.addEventListener(
        "pointerleave",
        () => {
          pointer.targetActive = 0;
        },
        { passive: true },
      );
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.round(rect.width);
      height = Math.round(rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    };

    const draw = (timeMs) => {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);

      // Smooth pointer easing for responsive retro-pixel wake
      pointer.x += (pointer.targetX - pointer.x) * 0.11;
      pointer.y += (pointer.targetY - pointer.y) * 0.11;
      pointer.active += (pointer.targetActive - pointer.active) * 0.08;

      const t = timeMs * 0.00055;
      const cell = width < 380 ? 11 : 13;
      const cols = Math.floor(width / cell);
      const rows = Math.floor(height / cell);
      const offsetX = Math.floor((width - cols * cell) / 2);
      const offsetY = Math.floor((height - rows * cell) / 2);

      const blobs = [
        { x: 0.48 + Math.sin(t * 0.95) * 0.13, y: 0.44 + Math.cos(t * 0.72) * 0.11, r: 0.27 },
        { x: 0.65 + Math.cos(t * 0.8) * 0.11, y: 0.57 + Math.sin(t * 1.05) * 0.12, r: 0.24 },
        {
          x: 0.34 + Math.sin(t * 1.15 + 1.8) * 0.1,
          y: 0.59 + Math.cos(t * 0.9 + 1.1) * 0.11,
          r: 0.22,
        },
        {
          x: 0.56 + Math.cos(t * 0.65 + 2.7) * 0.14,
          y: 0.33 + Math.sin(t * 0.85 + 0.6) * 0.09,
          r: 0.2,
        },
      ];

      // Subtle Swiss dot grid
      ctx.fillStyle = "rgba(17, 19, 24, 0.10)";
      for (let r = 1; r < rows; r += 2) {
        for (let c = 1; c < cols; c += 2) {
          ctx.fillRect(
            offsetX + c * cell + Math.floor(cell / 2),
            offsetY + r * cell + Math.floor(cell / 2),
            2,
            2,
          );
        }
      }

      const maxDim = Math.max(width, height);
      for (let r = 0; r < rows; r++) {
        const ny = (r + 0.5) / rows;
        for (let c = 0; c < cols; c++) {
          const nx = (c + 0.5) / cols;
          const edgeMask = Math.min(
            1,
            Math.min(Math.min(nx, 1 - nx) * 5.2, Math.min(ny, 1 - ny) * 5.2),
          );
          if (edgeMask <= 0.05) continue;

          let field = 0;
          for (let i = 0; i < blobs.length; i++) {
            const dx = (nx - blobs[i].x) * (width / maxDim);
            const dy = (ny - blobs[i].y) * (height / maxDim);
            field += (blobs[i].r * blobs[i].r) / (dx * dx + dy * dy + 0.004);
          }

          // Subtle interactive pixel cluster pulse around hovered pointer
          if (pointer.active > 0.01) {
            const pdx = (nx - pointer.x) * (width / maxDim);
            const pdy = (ny - pointer.y) * (height / maxDim);
            field += (0.032 * pointer.active) / (pdx * pdx + pdy * pdy + 0.014);
          }

          const wave = Math.sin(nx * 9.5 + t * 1.4) * Math.cos(ny * 7.0 - t * 1.1) * 0.14;
          const val = (field + wave) * edgeMask;
          const bayer = BAYER[r & 3][c & 3] / 16;
          const px = offsetX + c * cell;
          const py = offsetY + r * cell;
          const block = cell - 1;

          if (val > 1.55) {
            ctx.fillStyle = "#0033FF";
            ctx.fillRect(px, py, block, block);
          } else if (val > 1.05) {
            ctx.fillStyle = val - 1.05 > bayer * 0.5 ? "#0033FF" : "#2957FF";
            ctx.fillRect(px, py, block, block);
          } else if (val > 0.72) {
            if (val - 0.72 > bayer * 0.36) {
              ctx.fillStyle = bayer > 0.55 ? "#0033FF" : "#8FA8FF";
              ctx.fillRect(px, py, block, block);
            }
          } else if (val > 0.54 && bayer > 0.78) {
            ctx.fillStyle = "#B8C8FF";
            ctx.fillRect(px + 2, py + 2, block - 4, block - 4);
          }
        }
      }

      // Registration crosshairs
      ctx.fillStyle = "#0033FF";
      [
        [offsetX + cell * 2, offsetY + cell * 2],
        [offsetX + (cols - 3) * cell, offsetY + cell * 2],
        [offsetX + (cols - 3) * cell, offsetY + (rows - 3) * cell],
      ].forEach(([mx, my]) => {
        const cx = Math.round(mx);
        const cy = Math.round(my);
        ctx.fillRect(cx - 5, cy, 11, 1);
        ctx.fillRect(cx, cy - 5, 1, 11);
      });
    };

    const loop = (now) => {
      if (!isVisible || prefersReducedMotion) {
        rafId = null;
        return;
      }
      draw(now);
      rafId = window.requestAnimationFrame(loop);
    };

    const startCanvas = () => {
      if (prefersReducedMotion) {
        draw(2400);
        return;
      }
      if (isVisible && rafId === null) {
        rafId = window.requestAnimationFrame(loop);
      }
    };

    const stopCanvas = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    new ResizeObserver(() => {
      resize();
      if (prefersReducedMotion) draw(2400);
    }).observe(canvas);

    new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
        if (isVisible) startCanvas();
        else stopCanvas();
      },
      { threshold: 0.01 },
    ).observe(canvas);

    motionQuery.addEventListener("change", (e) => {
      prefersReducedMotion = e.matches;
      stopCanvas();
      startCanvas();
    });

    resize();
    startCanvas();
  }

  /* -----------------------------------------------------------
   * 7. Smooth Spring-Damped 60fps Scroll Zoom, Progress & Nav Spy
   * ----------------------------------------------------------- */
  const heroSection = document.getElementById("heroSection");
  const heroPixelScroll = document.getElementById("heroPixelScroll");
  const contractSection = document.getElementById("contract");
  const contractBandInner = document.getElementById("contractBandInner");
  const terminalSection = document.getElementById("terminal");
  const terminalViewport = document.getElementById("terminalViewport");
  const scrollProgressBar = document.getElementById("scrollProgressBar");
  const waveSvgs = Array.from(document.querySelectorAll(".pixel-wave svg"));
  const navLinks = Array.from(document.querySelectorAll(".nav-links a[data-nav-section]"));
  const spyTargets = navLinks
    .map((link) => ({
      id: link.dataset.navSection,
      link,
      el: document.getElementById(link.dataset.navSection || ""),
    }))
    .filter((item) => item.el);

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const state = { hero: 0, contract: 1, terminal: 1, page: 0 };
  const target = { hero: 0, contract: 1, terminal: 1, page: 0 };
  let scrollRaf = null;

  const updateActiveNav = () => {
    const anchorY = window.innerHeight * 0.34;
    let activeId = "";
    for (const item of spyTargets) {
      const rect = item.el.getBoundingClientRect();
      if (rect.top <= anchorY && rect.bottom > 90) {
        activeId = item.id;
      }
    }
    spyTargets.forEach((item) => {
      item.link.classList.toggle("is-active", item.id === activeId);
    });
  };

  const computeScrollTargets = () => {
    const vh = window.innerHeight || 800;
    const docMax = Math.max(1, document.documentElement.scrollHeight - vh);
    target.page = clamp01(window.scrollY / docMax);

    if (heroSection) {
      const r = heroSection.getBoundingClientRect();
      target.hero = clamp01(-r.top / Math.max(r.height, 1));
    }
    if (contractSection) {
      const r = contractSection.getBoundingClientRect();
      target.contract = clamp01((vh - r.top) / (vh * 0.65));
    }
    if (terminalSection) {
      const r = terminalSection.getBoundingClientRect();
      target.terminal = clamp01((vh - r.top) / (vh * 0.65));
    }
    updateActiveNav();
  };

  const tickScroll = () => {
    if (prefersReducedMotion) {
      if (scrollProgressBar) {
        scrollProgressBar.style.transform = `scaleX(${target.page.toFixed(4)})`;
      }
      scrollRaf = null;
      return;
    }
    const ease = 0.095;
    state.hero += (target.hero - state.hero) * ease;
    state.contract += (target.contract - state.contract) * ease;
    state.terminal += (target.terminal - state.terminal) * ease;
    state.page += (target.page - state.page) * 0.18;

    if (scrollProgressBar) {
      scrollProgressBar.style.transform = `scaleX(${state.page.toFixed(4)})`;
    }
    if (heroPixelScroll) {
      const scale = 1 + state.hero * 0.2;
      const y = -state.hero * 28;
      heroPixelScroll.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
    }
    if (contractBandInner) {
      const s = 0.96 + state.contract * 0.04;
      contractBandInner.style.transform = `scale(${s.toFixed(4)})`;
    }
    if (terminalViewport) {
      const s = 0.95 + state.terminal * 0.05;
      terminalViewport.style.transform = `scale(${s.toFixed(4)})`;
    }
    waveSvgs.forEach((svg, idx) => {
      const dir = idx % 2 === 0 ? 1 : -1;
      const flip =
        svg.parentElement && svg.parentElement.classList.contains("pixel-wave--flip") ? -1 : 1;
      const amp = window.innerWidth < 640 ? 8 : 18;
      const shift = ((state.page - 0.5) * amp * dir).toFixed(2);
      svg.style.transform = `translate3d(${shift}px, 0, 0) scaleX(1.04) scaleY(${flip})`;
    });

    const settled =
      Math.abs(target.hero - state.hero) < 0.0008 &&
      Math.abs(target.contract - state.contract) < 0.0008 &&
      Math.abs(target.terminal - state.terminal) < 0.0008 &&
      Math.abs(target.page - state.page) < 0.0008;

    if (!settled) {
      scrollRaf = window.requestAnimationFrame(tickScroll);
    } else {
      scrollRaf = null;
    }
  };

  const onScroll = () => {
    computeScrollTargets();
    if (prefersReducedMotion) {
      if (scrollProgressBar) {
        scrollProgressBar.style.transform = `scaleX(${target.page.toFixed(4)})`;
      }
      return;
    }
    if (scrollRaf === null) {
      scrollRaf = window.requestAnimationFrame(tickScroll);
    }
  };

  computeScrollTargets();
  state.hero = target.hero;
  state.contract = target.contract;
  state.terminal = target.terminal;
  state.page = target.page;
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  tickScroll();

  /* -----------------------------------------------------------
   * 8. Module Card Scroll Reveal (IntersectionObserver)
   * ----------------------------------------------------------- */
  const cards = document.querySelectorAll(".module-card");
  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    cards.forEach((c) => c.classList.add("is-visible"));
  } else {
    const cardObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            cardObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14 },
    );
    cards.forEach((c) => cardObserver.observe(c));
  }

  /* -----------------------------------------------------------
   * 9. Procedural Pixel-Dither Decode Mask on Contract Headers
   * ----------------------------------------------------------- */
  const ditherHeaders = Array.from(document.querySelectorAll("[data-dither-reveal]"));
  if (!prefersReducedMotion && ditherHeaders.length && "IntersectionObserver" in window) {
    const BAYER_MASK = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];

    const attachMaskCanvas = (el) => {
      const mask = document.createElement("canvas");
      mask.className = "dither-mask-canvas";
      mask.setAttribute("aria-hidden", "true");
      el.appendChild(mask);

      const ctx = mask.getContext("2d", { alpha: true });
      const syncSize = () => {
        const rect = el.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width + 4));
        const h = Math.max(1, Math.round(rect.height + 6));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        mask.width = Math.round(w * dpr);
        mask.height = Math.round(h * dpr);
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.imageSmoothingEnabled = false;
        }
        return { w, h };
      };

      const drawMask = (progress) => {
        if (!ctx) return;
        const rect = el.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width + 4));
        const h = Math.max(1, Math.round(rect.height + 6));
        ctx.clearRect(0, 0, w, h);

        const cell = window.innerWidth < 640 ? 6 : 8;
        const cols = Math.ceil(w / cell);
        const rows = Math.ceil(h / cell);
        // Wavefront sweeps from -0.22 to 1.28 so the whole header starts masked and finishes 100% clear
        const wave = progress * 1.5 - 0.22;

        for (let r = 0; r < rows; r++) {
          const ny = rows > 1 ? r / (rows - 1) : 0;
          for (let c = 0; c < cols; c++) {
            const nx = cols > 1 ? c / (cols - 1) : 0;
            const bayer = BAYER_MASK[r & 3][c & 3] / 16;
            // Left-to-right diagonal decoding sweep modulated by Bayer ordered threshold
            const cellPos = nx * 0.72 + ny * 0.14 + bayer * 0.26;
            const delta = cellPos - wave;

            if (delta > 0.14) {
              // Unrevealed area: solid electric blue matching the Contract band seamlessly
              ctx.fillStyle = "#0033FF";
              ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
            } else if (delta > 0.04) {
              // Active decoding scan frontier: retro cobalt + crisp white pixel flicker
              ctx.fillStyle = bayer > 0.52 ? "#4D73FF" : "#0033FF";
              ctx.fillRect(c * cell, r * cell, cell, cell);
            } else if (delta > -0.045) {
              // Trailing white pixel-decode sparks
              if (((c * 5 + r * 3) & 3) === 0) {
                ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
                ctx.fillRect(c * cell, r * cell, Math.max(3, cell - 2), Math.max(3, cell - 2));
              }
            }
          }
        }
      };

      syncSize();
      drawMask(0);

      const runDecode = () => {
        const delay = Number(el.dataset.ditherDelay || "0");
        const duration = window.innerWidth < 640 ? 640 : 760;
        window.setTimeout(() => {
          syncSize();
          const start = performance.now();
          const step = (now) => {
            const raw = clamp01((now - start) / duration);
            // Crisp ease-out decode curve
            const eased = 1 - Math.pow(1 - raw, 2.2);
            drawMask(eased);
            if (raw < 1) {
              window.requestAnimationFrame(step);
            } else {
              mask.remove();
            }
          };
          window.requestAnimationFrame(step);
        }, delay);
      };

      return { mask, runDecode, syncSize, drawMask };
    };

    const maskControllers = new Map();
    ditherHeaders.forEach((el) => {
      maskControllers.set(el, attachMaskCanvas(el));
    });

    const ditherObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const ctrl = maskControllers.get(entry.target);
            if (ctrl) {
              ctrl.runDecode();
              maskControllers.delete(entry.target);
            }
            ditherObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 },
    );

    ditherHeaders.forEach((el) => ditherObserver.observe(el));

    window.addEventListener(
      "resize",
      () => {
        maskControllers.forEach((ctrl) => {
          ctrl.syncSize();
          ctrl.drawMask(0);
        });
      },
      { passive: true },
    );
  }

  /* -----------------------------------------------------------
   * 10. Mobile Drawer Escape & Outside Tap Dismissal
   * ----------------------------------------------------------- */
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mobileDrawer && mobileDrawer.classList.contains("is-open")) {
      setDrawer(false);
    }
  });

  document.addEventListener("click", (e) => {
    if (!mobileDrawer || !mobileDrawer.classList.contains("is-open")) return;
    const header = document.querySelector(".site-header");
    if (header && !header.contains(e.target)) {
      setDrawer(false);
    }
  });
})();
