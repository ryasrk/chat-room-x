# 📱 Mobile Layout Improvement Plan — Chat Room X Dashboard

> **Status:** Planning  
> **Priority:** HIGH  
> **Affected views:** Rooms → Agent Room (detail + chat), Header, Sidebar  
> **Breakpoints:** ≤480px (phone), ≤768px (mobile), ≤900px (tablet)

---

## 🔍 Audit Summary (dari screenshot + code review)

### Masalah yang Ditemukan

| # | Issue | Severity | UX Rule Violated | File |
|---|-------|----------|------------------|------|
| 1 | **Header terlalu padat** — Logo + nav tabs + icons semua di satu baris, lalu wrap ke baris kedua. Pada layar kecil (≤375px) nav tabs terlalu sempit dan teks terpotong | HIGH | `content-priority`, `touch-target-size` | `mobile.css` |
| 2 | **Room header action buttons overflow** — Tombol (CONNECTED, AI, Artifacts, ZIP, Invite, Leave, Delete) wrap ke banyak baris, memakan ~30% viewport height | CRITICAL | `overflow-menu`, `content-priority`, `touch-density` | `mobile.css`, `rooms.css` |
| 3 | **Conversation area terlalu kecil** — Karena header + room-header + action buttons + bot pills + composer semua visible, area chat hanya tersisa ~40% viewport | CRITICAL | `visual-hierarchy`, `content-priority` | `rooms.css`, `mobile.css` |
| 4 | **Bot pills horizontal scroll tidak jelas** — Tidak ada affordance bahwa pills bisa di-scroll horizontal | MEDIUM | `swipe-clarity`, `horizontal-scroll` | `rooms.css` |
| 5 | **Handoff Flow section memakan ruang** — Section "HANDOFF FLOW" dan conversation history visible di bawah chat, membuat scroll panjang | HIGH | `progressive-disclosure`, `content-priority` | `rooms.css` |
| 6 | **Touch targets terlalu kecil** — Beberapa button (ZIP, Invite, Leave) hanya 28px height pada ≤480px, di bawah minimum 44px | HIGH | `touch-target-size` (min 44×44pt) | `mobile.css` |
| 7 | **Delete button merah tanpa konfirmasi visual** — Tombol Delete langsung terlihat tanpa separation dari action lain | MEDIUM | `destructive-emphasis`, `destructive-nav-separation` | `rooms.css` |
| 8 | **Font size terlalu kecil** — Beberapa label (9px, 10px) sulit dibaca di mobile | MEDIUM | `readable-font-size` (min 12px) | `mobile.css` |
| 9 | **Composer input terlalu dekat bottom edge** — Pada notched phones, safe-area padding ada tapi spacing masih tight | LOW | `safe-area-awareness` | `mobile.css` |
| 10 | **Agent sidebar (collapsed) masih memakan layout space** — Toggle button 100% width menambah visual noise | LOW | `scroll-behavior` | `mobile.css` |

---

## 🏗️ Implementation Plan

### Phase 1: Room Header Redesign (CRITICAL — Impact Tertinggi)

**Problem:** Room header dengan semua action buttons memakan terlalu banyak ruang vertikal.

**Solution:** Overflow menu pattern — hanya tampilkan 2-3 primary actions, sisanya masuk ke overflow "⋯" menu.

#### Tasks:

**1.1 — Buat overflow menu component**
- File: `src/roomsUI.js` (atau buat `src/overflowMenu.js`)
- Buat dropdown menu yang muncul dari tombol "⋯"
- Menu items: ZIP, Invite, Leave, Delete
- Delete di-separate dengan divider + warna merah

**1.2 — Refactor room-chat-header untuk mobile**
- File: `src/mobile.css`
- Layout baru pada ≤768px:
  ```
  ┌─────────────────────────────────────┐
  │ ← │ AI AGENT ROOM │ Riset    │ ⋯ │
  │   │ 🟢 CONNECTED  │ 3 bots   │   │
  └─────────────────────────────────────┘
  ```
- Primary actions visible: Back (←), Connection status
- Secondary actions (AI, Artifacts, ZIP, Invite, Leave, Delete) → overflow menu
- Estimasi: Header height dari ~120px → ~56px (hemat ~64px)

**1.3 — Pindahkan Delete ke overflow menu dengan konfirmasi**
- File: `src/roomsUI.js`
- Delete harus di paling bawah overflow menu
- Warna merah + icon warning
- Trigger confirmation modal sebelum delete

#### CSS Changes:
```css
/* Target state setelah fix */
@media (max-width: 768px) {
  .room-chat-header {
    padding: 8px 12px;
    gap: 8px;
    flex-wrap: nowrap;      /* STOP wrapping */
    align-items: center;
    min-height: 52px;
    max-height: 56px;       /* Fixed height */
  }
  
  .room-chat-actions {
    width: auto;            /* STOP full-width */
    flex-wrap: nowrap;
    order: 0;               /* STOP reordering */
    border-top: none;
    padding-top: 0;
  }
  
  /* Hide secondary actions, show overflow trigger */
  .room-chat-actions .btn-sm:not(.btn-primary-action) {
    display: none;
  }
  
  .room-overflow-trigger {
    display: flex;
  }
}
```

---

### Phase 2: Conversation Area Maximization (CRITICAL)

**Problem:** Chat messages hanya mendapat ~40% viewport karena header, room-header, bot pills, dan composer semua visible.

**Solution:** Collapse non-essential UI, maximize message area.

#### Tasks:

**2.1 — Bot pills: collapsible on mobile**
- File: `src/mobile.css`, `src/roomChat.js`
- Default: collapsed (hidden) pada mobile
- Tampilkan hanya saat user tap "3 bot members" di header
- Atau: tampilkan sebagai single-line summary "🤖 planner → reviewer → coder"

**2.2 — Handoff Flow: collapsible accordion**
- File: `src/agentHandoffViz.js`, `src/mobile.css`
- Default: collapsed pada mobile
- Tampilkan toggle "📋 Handoff Flow ▾" yang bisa di-expand
- Saat collapsed, tampilkan summary satu baris

**2.3 — Sticky composer dengan proper spacing**
- File: `src/mobile.css`
- Composer harus sticky di bottom
- Chat messages scroll di antara header dan composer
- Pastikan safe-area padding cukup untuk notched phones

#### Target Layout (≤768px):
```
┌──────────────────────────────┐ ← 56px
│ ← AI AGENT ROOM  Riset   ⋯ │
│   🟢 CONNECTED · 3 bots     │
├──────────────────────────────┤
│                              │
│  [Chat messages scrollable]  │ ← flex: 1 (sisa viewport)
│                              │
│  ▸ Handoff Flow (collapsed)  │ ← ~32px saat collapsed
│                              │
├──────────────────────────────┤
│ Message the room...      [↑] │ ← ~52px + safe-area
└──────────────────────────────┘
```

**Viewport budget (iPhone 14, 844px height):**
- Status bar: 54px
- App header: 44px (nav tabs)
- Room header: 56px (setelah fix)
- Composer: 52px + 34px safe-area = 86px
- **Available for chat: 844 - 54 - 44 - 56 - 86 = 604px** ✅ (71% viewport)
- Sebelum fix: ~340px (40% viewport) ❌

---

### Phase 3: Touch Target & Typography Fix (HIGH)

**Problem:** Beberapa interactive elements di bawah 44px minimum, font sizes terlalu kecil.

#### Tasks:

**3.1 — Audit dan fix semua touch targets < 44px**
- File: `src/mobile.css`
- Elements yang perlu fix:
  - `.room-chat-header .btn-sm` → min-height: 44px (currently 28px pada ≤480px)
  - `.room-chat-bot-status` → padding increase
  - `.sidebar-section-toggle` → min-height: 44px
  - `.agent-room-header-meta .agent-room-connection` → min-height: 44px
  - `.room-mention-item` → min-height: 44px

**3.2 — Fix minimum font sizes**
- File: `src/mobile.css`
- Semua text yang visible harus ≥ 11px (absolute minimum), prefer ≥ 12px
- Elements yang perlu fix:
  - `.room-chat-kind` (9px → 11px)
  - `.agent-room-header-meta .agent-room-connection` (9px → 11px)
  - `.room-chat-header .btn-sm` (9px pada ≤480px → 11px)
  - `.sidebar-section-toggle` (9px pada ≤480px → 11px)
  - `.room-msg-type-badge` (9px → 11px)
  - `.agent-room-log-header` (10px → 11px)

**3.3 — Touch spacing between interactive elements**
- Minimum 8px gap antara touch targets
- Fix `.room-chat-actions` gap dari 3px → 8px pada ≤480px

---

### Phase 4: Agent Sidebar Mobile UX (MEDIUM)

**Problem:** Agent sidebar (Handoff/Progress/Logs) mengambil 50vh saat expanded, toggle button memakan space saat collapsed.

#### Tasks:

**4.1 — Bottom sheet pattern untuk agent sidebar**
- File: `src/mobile.css`, `src/roomChat.js`
- Pada mobile, agent sidebar menjadi bottom sheet (slide up dari bawah)
- Default: collapsed (hanya toggle bar visible, ~32px)
- Expanded: 60vh max-height dengan drag handle
- Bisa di-swipe down untuk dismiss

**4.2 — Sidebar toggle redesign**
- Ganti full-width toggle button dengan compact pill/handle
- Tampilkan summary info: "📊 2 handoffs · 3 logs"
- Tap untuk expand bottom sheet

---

### Phase 5: Navigation & Header Polish (MEDIUM)

**Problem:** Header nav tabs terlalu sempit pada small phones, icon-only tidak cukup jelas.

#### Tasks:

**5.1 — Nav tabs: icon + short label**
- File: `src/mobile.css`
- Pada ≤480px, gunakan icon + abbreviated label:
  - 💬 Chat
  - 🏠 Rooms  
  - 🧪 Play
- Pastikan setiap tab min-width: 64px

**5.2 — Header right: prioritize essential buttons**
- Pada ≤480px, hanya tampilkan: theme toggle + settings + user avatar
- Mode select sudah hidden (bagus)
- Shortcuts button sudah hidden (bagus)

**5.3 — Sidebar backdrop z-index fix**
- Pastikan sidebar backdrop menutupi semua content termasuk room header
- z-index hierarchy: sidebar(50) > backdrop(45) > room-header(10)

---

### Phase 6: Micro-interactions & Polish (LOW)

#### Tasks:

**6.1 — Scroll affordance untuk bot pills**
- Tambahkan fade gradient di kanan untuk indicate scrollable content
- Atau tambahkan scroll indicator dots

**6.2 — Smooth transitions**
- Semua collapse/expand menggunakan CSS transitions (sudah ada, verify consistency)
- Bottom sheet slide-up animation: 250ms ease-out

**6.3 — Landscape mode optimization**
- Verify layout pada landscape orientation
- Header harus single-line pada landscape
- Chat area harus maximize horizontal space

**6.4 — Pull-to-refresh gesture area**
- Pastikan pull-to-refresh (jika ada) tidak conflict dengan scroll

---

## 📋 Implementation Priority & Effort

| Phase | Priority | Effort | Impact | Files Changed |
|-------|----------|--------|--------|---------------|
| Phase 1 | 🔴 CRITICAL | ~4h | Hemat ~64px viewport | `mobile.css`, `roomsUI.js`, baru: `overflowMenu.js` |
| Phase 2 | 🔴 CRITICAL | ~3h | Hemat ~100px viewport | `mobile.css`, `roomChat.js`, `agentHandoffViz.js` |
| Phase 3 | 🟡 HIGH | ~2h | A11y compliance | `mobile.css` |
| Phase 4 | 🟠 MEDIUM | ~3h | Better sidebar UX | `mobile.css`, `roomChat.js` |
| Phase 5 | 🟠 MEDIUM | ~2h | Better nav UX | `mobile.css` |
| Phase 6 | 🟢 LOW | ~2h | Polish | `mobile.css`, various |

**Total estimated effort: ~16 hours**

---

## 🎯 Success Criteria

1. ✅ Chat message area ≥ 60% viewport height pada iPhone 14 (375×844)
2. ✅ Semua touch targets ≥ 44×44px
3. ✅ Semua visible text ≥ 11px
4. ✅ Room header max 56px height (single row)
5. ✅ No horizontal scroll pada main content
6. ✅ Smooth transitions pada semua collapse/expand
7. ✅ Safe area support untuk notched phones
8. ✅ Landscape mode tetap usable

## 🧪 Testing Checklist

- [ ] iPhone SE (375×667) — smallest common phone
- [ ] iPhone 14 (390×844) — standard phone
- [ ] iPhone 14 Pro Max (430×932) — large phone
- [ ] Samsung Galaxy S23 (360×780) — Android standard
- [ ] iPad Mini (768×1024) — tablet breakpoint
- [ ] Landscape mode semua device di atas
- [ ] Test dengan keyboard visible (composer focus)
- [ ] Test dengan notch/Dynamic Island
- [ ] Test touch targets dengan finger (bukan mouse)

---

## 📐 Design Reference

### Spacing Scale (4px base)
```
4px  — micro gap
8px  — element gap  
12px — section padding (mobile)
16px — card padding (mobile)
20px — page padding (desktop)
```

### Touch Target Minimum
```
44×44px — Apple HIG
48×48dp — Material Design
8px     — minimum gap between targets
```

### Font Size Scale (mobile)
```
11px — minimum (badges, timestamps)
12px — secondary text, labels
13px — body text (compact)
14px — body text (standard)
16px — input text (prevents iOS zoom)
18px — heading (mobile)
```

### Z-Index Scale
```
1    — elevated cards
10   — header, sticky elements
45   — sidebar backdrop
50   — sidebar overlay
100  — modals
200  — user dropdown, overflow menu
1000 — toast notifications
```
