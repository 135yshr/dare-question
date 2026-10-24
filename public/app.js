import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, collection, onSnapshot, getDoc, setDoc, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { QUESTIONS } from "./questions.js";

const QMAP = Object.fromEntries(QUESTIONS.map(q => [q.id, q]));
const ALL_CHOICES_MAX = 8;   // 登録人数がこれ以下なら全員から選ぶ。超えたら正解＋3人の4択
const DEFAULT_PER = 5;
const MODE = document.body.dataset.mode; // "player" | "host"

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let uid = null, email = null, isHost = false, authState = "loading"; // loading | ok | needLogin | notHost | error
let state = null, secret = null, players = {}, answers = {}, votes = {}, myTurn = null, myVote = null;
let ready = { state: false, players: false };
let local = { nick: "", qs: [], idx: 0, answers: [], saving: false, error: "" };
let unsubs = [];
let lastHTML = "";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nameOf = id => players[id]?.nickname || "だれか";
const perPerson = () => state?.perPerson || DEFAULT_PER;
const qText = r => QMAP[r.q]?.q ?? "";
const aText = r => QMAP[r.q]?.o[r.a] ?? "";
const namesOf = ids => (ids || []).map(nameOf).join(" と ");

function setHTML(html) {
  if (html === lastHTML) return;
  lastHTML = html;
  const root = document.getElementById("app");
  const focusedId = document.activeElement?.id;
  const nickVal = document.getElementById("nick")?.value;
  root.innerHTML = html;
  const nickEl = document.getElementById("nick");
  if (nickEl && nickVal) nickEl.value = nickVal;
  if (focusedId) document.getElementById(focusedId)?.focus();
  const qr = document.getElementById("qr");
  if (qr && window.qrcode) {
    const q = window.qrcode(0, "M"); q.addData(joinURL()); q.make();
    qr.innerHTML = q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  }
}
const joinURL = () => location.origin + "/";
function badge(top, sub, body) {
  return `<div class="badge"><div class="badge-top"><div class="hello">${esc(top)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div><div class="badge-body">${body}</div></div>`;
}
const loading = `<div class="wrap"><p class="muted">読み込み中…</p></div>`;

/* ---------------- 参加者画面 ---------------- */
function playerView() {
  if (authState === "error") return `<div class="wrap stack"><h2>接続できませんでした</h2><p class="muted">ページを再読み込みしてください。直らない場合は主催者に声をかけてください。</p></div>`;
  if (authState !== "ok" || !ready.state || !ready.players) return loading;
  const mine = players[uid];
  if (!mine) return registerView();
  const r = state?.round;
  const nick = `<p class="note">あなたは <span class="hand">${esc(mine.nickname)}</span> として参加中</p>`;

  if (state?.phase === "question" && r) {
    if (myTurn?.round === r.id) {
      return `<div class="wrap stack">${badge("だれの回答？", "", `<p class="qtext">これはあなたの回答です</p>`)}<p class="muted">今回は投票できません。ばれないよう、すました顔で待っていてください。</p>${nick}</div>`;
    }
    const picked = myVote?.round === r.id ? myVote.pick : null;
    const opts = r.options.map(id => `<button class="opt" data-vote="${esc(id)}" aria-pressed="${picked === id}"><span class="hand" style="font-size:22px">${esc(nameOf(id))}</span></button>`).join("");
    return `<div class="wrap stack">
      <div class="panel stack"><p class="qcount">${esc(qText(r))}</p><p class="qtext">${esc(aText(r))}</p></div>
      <h2>この回答、だれの？</h2>
      <div class="opts">${opts}</div>
      <p class="note">${picked ? "投票しました。締め切りまでは変えられます。" : "名前をタップして投票"}</p>${nick}</div>`;
  }
  if (state?.phase === "reveal" && r) {
    const picked = myVote?.round === r.id ? myVote.pick : null;
    let res;
    const subjects = r.subjects || [];
    if (subjects.includes(uid)) res = `<div class="result ng">${subjects.length > 1 ? "あなたも同じ回答でした" : "あなたの回答でした"}</div>`;
    else if (!picked) res = `<div class="result ng">今回は投票なし</div>`;
    else if (subjects.includes(picked)) res = `<div class="result ok">正解！</div>`;
    else res = `<div class="result ng">ざんねん、${esc(nameOf(picked))} ではありませんでした</div>`;
    return `<div class="wrap stack">${badge("正解は…", subjects.length > 1 ? "同じ回答の人が複数いました" : "", `<div class="badge-name hand">${esc(namesOf(subjects))}</div>`)}${res}
      <p class="muted">${esc(qText(r))} → ${esc(aText(r))}</p>${nick}</div>`;
  }
  if (state?.phase === "done") {
    return `<div class="wrap stack">${badge("おしまい", "", `<p class="qtext">全員の回答を出し切りました</p>`)}${nick}</div>`;
  }
  return `<div class="wrap stack">${badge("HELLO", "my name is", `<div class="badge-name hand">${esc(mine.nickname)}</div>`)}
    <p class="qtext">登録できました</p><p class="muted">当てっこが始まると、この画面に問題が出ます。スマホはこのまま開いておいてください。</p></div>`;
}

function registerView() {
  const err = local.error ? `<p class="note" style="color:var(--badge)">${esc(local.error)}</p>` : "";
  if (!local.qs.length) {
    return `<div class="wrap stack">${badge("HELLO", "my name is", `<input id="nick" class="field hand" style="text-align:center;font-size:28px" maxlength="16" placeholder="ニックネーム" autocomplete="off">`)}
      <p class="muted">当てっこで表示される名前です。会場のみんながわかる名前にしてください。</p>
      <button class="btn" id="startAnswer">質問に答える（${perPerson()}問）</button>${err}</div>`;
  }
  if (local.idx < local.qs.length) {
    const q = QMAP[local.qs[local.idx]];
    const pct = Math.round(local.idx / local.qs.length * 100);
    const opts = q.o.map((t, i) => `<button class="opt" data-ans="${i}" aria-pressed="${local.answers[local.idx] === i}">${esc(t)}</button>`).join("");
    return `<div class="wrap stack">
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
      <p class="qcount">${local.idx + 1} / ${local.qs.length}</p>
      <p class="qtext">${esc(q.q)}</p>
      <div class="opts">${opts}</div>
      <div class="row">${local.idx > 0 ? `<button class="btn ghost" id="back" style="width:auto">戻る</button>` : ""}<button class="btn ghost" id="reroll" style="width:auto">別の質問にする</button></div>
    </div>`;
  }
  const list = local.qs.map((id, i) => `<li><span class="muted">${esc(QMAP[id].q)}</span><br><b>${esc(QMAP[id].o[local.answers[i]])}</b></li>`).join("");
  return `<div class="wrap stack"><h2>この内容で登録します</h2>
    <p>名前：<span class="hand" style="font-size:22px">${esc(local.nick)}</span></p>
    <ul class="stack" style="padding-left:1.2em;margin:0">${list}</ul>
    <button class="btn" id="submit" ${local.saving ? "disabled" : ""}>${local.saving ? "登録しています…" : "登録する"}</button>
    <button class="btn ghost" id="redo">最初からやり直す</button>${err}</div>`;
}

/* ---------------- 司会画面 ---------------- */
// 登録者の回答を「質問:選んだ番号」ごとにまとめる。同じ回答の人は同じグループになる
function answerGroups() {
  const used = new Set(secret?.used || []); const groups = new Map();
  for (const [id, a] of Object.entries(answers)) {
    if (!players[id]) continue;
    (a.answers || []).forEach((x, i) => {
      const k = x.q + ":" + x.a;
      if (!groups.has(k)) groups.set(k, { q: x.q, a: x.a, ids: [], keys: [], used: false });
      const g = groups.get(k);
      if (!g.ids.includes(id)) g.ids.push(id);
      g.keys.push(id + ":" + i);
      if (used.has(id + ":" + i)) g.used = true;
    });
  }
  return [...groups.values()];
}
const remaining = () => answerGroups().filter(g => !g.used).length;
// ヒント候補：ヒント元の人の回答のうち、まだ出題もヒントもしていないもの（同じ回答の人の分で使ったものも除く）
function hintCandidates() {
  const from = secret?.hintFrom; if (!from || !players[from]) return [];
  const usedGroups = new Set(answerGroups().filter(g => g.used).map(g => g.q + ":" + g.a));
  return (answers[from]?.answers || []).map((x, i) => ({ q: x.q, a: x.a, key: from + ":" + i })).filter(x => !usedGroups.has(x.q + ":" + x.a));
}
function hintsHTML() {
  const hs = secret?.hints || []; if (!hs.length) return "";
  return `<div class="panel hints"><h2>ヒント：この人はほかにこう答えています</h2><ol>${hs.map(h => `<li><span class="muted">${esc(QMAP[h.q]?.q)}</span><br><b>${esc(QMAP[h.q]?.o[h.a])}</b></li>`).join("")}</ol></div>`;
}
function hostView() {
  if (authState === "loading") return loading;
  if (authState === "needLogin") return `<div class="wrap stack" style="max-width:560px">${badge("司会画面", "", `<p class="muted">司会として登録した Google アカウントでログインしてください。</p>`)}<button class="btn" id="login" style="width:100%">Google でログイン</button></div>`;
  if (authState === "notHost") return `<div class="wrap stack" style="max-width:640px"><h2>このアカウントは司会として登録されていません</h2>
    <p class="muted">Firestore の <b>admins</b> コレクションに、ドキュメント ID が <b>${esc(email)}</b> のドキュメントを作成してから再読み込みしてください。</p>
    <button class="btn ghost" id="logout" style="width:auto">別のアカウントでログイン</button></div>`;
  if (authState === "error") return `<div class="wrap"><p>接続できませんでした。再読み込みしてください。</p></div>`;
  if (!ready.state || !ready.players) return loading;

  const ids = Object.keys(players);
  const phase = state?.phase || "lobby";
  const r = state?.round;
  const reset = `<button class="btn danger" id="reset">全部リセット</button>`;
  const abort = `<div class="row"><button class="btn ghost" id="abort" style="width:auto">中断して登録受付に戻る</button>${reset}</div>`;

  if (phase === "lobby") {
    const chips = ids.length ? ids.map(id => `<span class="chip hand">${esc(nameOf(id))}</span>`).join("") : `<p class="muted">まだだれも登録していません。</p>`;
    return `<div class="wrap"><div class="host-grid">
      <div class="stack">${badge("この回答、だれの？", "スマホで質問に答えて、当てっこしよう", `<div class="row" style="justify-content:center;gap:32px"><div id="qr" class="qr" aria-label="参加用QRコード"></div><div><div class="bigcount">${ids.length}</div><p class="muted" style="font-size:20px">人が登録済み</p></div></div><p class="url" style="margin-top:14px">${esc(joinURL())}</p>`)}
        <div class="chips">${chips}</div></div>
      <div class="panel stack"><h2>一人あたりの質問数</h2>
        <div class="stepper"><button id="perMinus" aria-label="減らす">−</button><output>${perPerson()}</output><button id="perPlus" aria-label="増やす">＋</button></div>
        <p class="note">これから回答する人に適用されます。質問は全${QUESTIONS.length}問からランダムに出ます。</p>
        <button class="btn" id="begin" ${ids.length < 2 ? "disabled" : ""}>当てっこを始める</button>
        ${ids.length < 2 ? `<p class="note">2人以上の登録が必要です。</p>` : ""}
        <div>${reset}</div></div></div></div>`;
  }
  if (phase === "question" && r) {
    const voted = Object.entries(votes).filter(([id, v]) => v.round === r.id && !secret?.subjects?.includes(id) && players[id]).length;
    const canVote = ids.filter(id => !secret?.subjects?.includes(id)).length;
    const hintLeft = hintCandidates().length;
    return `<div class="wrap"><div class="host-grid">
      <div class="stack">${badge("この回答、だれの？", `第${state.roundNo}問`, `<p class="host-q">${esc(qText(r))}</p><p class="host-a">${esc(aText(r))}</p>`)}${hintsHTML()}</div>
      <div class="panel stack"><p class="muted">投票</p><div class="bigcount">${voted}<span style="font-size:32px" class="muted"> / ${canVote}</span></div>
        <p class="note">選択肢：${r.options.length}人から選ぶ</p>
        <button class="btn ghost" id="hint" ${hintLeft ? "" : "disabled"}>${hintLeft ? `ヒントを出す（あと${hintLeft}つ）` : "ヒントはもうありません"}</button>
        <p class="note">ヒントで見せた回答は、あとで問題として出しません。</p>
        <button class="btn" id="close">締め切って正解を発表</button>${abort}</div></div></div>`;
  }
  if (phase === "reveal" && r) {
    const subjects = r.subjects || [];
    const vs = Object.entries(votes).filter(([id, v]) => v.round === r.id && !subjects.includes(id) && players[id]);
    const tally = {}; vs.forEach(([, v]) => tally[v.pick] = (tally[v.pick] || 0) + 1);
    const max = Math.max(1, ...Object.values(tally));
    const bars = r.options.map(id => `<div class="bar ${subjects.includes(id) ? "hit" : ""}"><span class="who hand">${esc(nameOf(id))}</span><span class="track"><i style="width:${(tally[id] || 0) / max * 100}%"></i></span><span class="n">${tally[id] || 0}</span></div>`).join("");
    const hits = vs.filter(([, v]) => subjects.includes(v.pick));
    const winners = hits.map(([id]) => `<span class="chip hand">${esc(nameOf(id))}</span>`).join("");
    const left = remaining();
    return `<div class="wrap"><div class="host-grid">
      <div class="stack">${badge("正解は…", `${qText(r)} → ${aText(r)}`, `<div class="badge-name hand write-in">${esc(namesOf(subjects))}</div>${subjects.length > 1 ? `<p class="muted">同じ回答の人が複数いたので、全員が正解です</p>` : ""}`)}
        <div><h2 style="margin-bottom:10px">当てた人（${hits.length}人）</h2><div class="chips">${winners || `<p class="muted">だれも当てられませんでした</p>`}</div></div>${hintsHTML()}</div>
      <div class="panel stack"><h2>投票の内訳</h2><div class="bars">${bars}</div>
        <p class="note">残り ${left} 問</p>
        <button class="btn" id="next">${left ? "次の問題へ" : "終了する"}</button>${abort}</div></div></div>`;
  }
  if (phase === "done") {
    return `<div class="wrap"><div class="stack">${badge("おしまい", "全員の回答を出し切りました", `<p class="qtext">${state.roundNo || 0}問、おつかれさまでした</p>`)}
      <div class="row"><button class="btn ghost" id="toLobby">登録受付に戻る（回答は残す）</button>${reset}</div></div></div>`;
  }
  return `<div class="wrap"><p>状態を読み込めませんでした。</p>${reset}</div>`;
}

/* ---------------- 司会の操作 ---------------- */
const stateRef = () => doc(db, "game", "state");
const secretRef = () => doc(db, "game", "secret");
const baseState = () => ({ phase: "lobby", perPerson: perPerson(), roundNo: 0, round: null });

async function patchState(patch) {
  await setDoc(stateRef(), { ...baseState(), ...(state || {}), ...patch });
}
function makeRound() {
  const pool = answerGroups().filter(g => !g.used);
  if (!pool.length) return null;
  // 同じ人が連続しないようにし、そのうえで回答がかぶっていないものを優先する
  const last = secret?.subjects || [];
  const fresh = pool.filter(g => !g.ids.some(id => last.includes(id)));
  const base = fresh.length ? fresh : pool;
  const unique = base.filter(g => g.ids.length === 1);
  const from = unique.length ? unique : base;
  const pick = from[Math.floor(Math.random() * from.length)];
  const ids = Object.keys(players);
  const main = pick.ids[Math.floor(Math.random() * pick.ids.length)];
  const options = ids.length <= ALL_CHOICES_MAX
    ? shuffle(ids)
    : shuffle([main, ...shuffle(ids.filter(x => !pick.ids.includes(x))).slice(0, 3)]);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { round: { id, q: pick.q, a: pick.a, options }, subjects: pick.ids, keys: pick.keys };
}
async function nextRound() {
  const m = makeRound();
  if (!m) { await patchState({ phase: "done", round: null }); return; }
  const b = writeBatch(db);
  // 同じ回答の人が複数いても、ヒントはそのうち1人の回答から出す（全員正解なので、その人に投票しても正解になる）
  const hintFrom = m.subjects[Math.floor(Math.random() * m.subjects.length)];
  b.set(secretRef(), { subjects: m.subjects, used: [...(secret?.used || []), ...m.keys], hintFrom, hints: [] });
  m.subjects.forEach(id => b.set(doc(db, "turns", id), { round: m.round.id }));
  b.set(stateRef(), { ...baseState(), ...(state || {}), phase: "question", round: m.round, roundNo: (state?.roundNo || 0) + 1 });
  await b.commit();
}
// ヒント元の人の回答を1つ選んで見せ、出題済みにする。司会画面を複数開いていても上書きし合わないようトランザクションで追記する
async function showHint() {
  const cand = hintCandidates(); if (!cand.length) return;
  const h = cand[Math.floor(Math.random() * cand.length)];
  await runTransaction(db, async tx => {
    const cur = (await tx.get(secretRef())).data() || {};
    if (cur.hintFrom !== secret.hintFrom || (cur.used || []).includes(h.key)) return; // 問題が進んだか、別の画面で同じヒントを出した
    tx.update(secretRef(), { hints: [...(cur.hints || []), { q: h.q, a: h.a }], used: [...(cur.used || []), h.key] });
  });
}
async function reveal() {
  await patchState({ phase: "reveal", round: { ...state.round, subjects: secret.subjects } });
}
// 登録と回答は残し、出題済みの記録だけ消して受付に戻す。次に始めると1問目からやり直しになる
async function abortGame() {
  if (!confirm("当てっこを中断して登録受付に戻ります。登録と回答は残り、次に始めると1問目からやり直します。よろしいですか？")) return;
  const b = writeBatch(db);
  b.set(secretRef(), { subjects: [], used: [], hintFrom: null, hints: [] });
  b.set(stateRef(), { ...baseState(), ...(state || {}), phase: "lobby", round: null, roundNo: 0 });
  await b.commit();
}
async function resetAll() {
  if (!confirm("登録者・回答・投票をすべて消して最初からにします。よろしいですか？")) return;
  const refs = [];
  for (const id of new Set([...Object.keys(players), ...Object.keys(answers), ...Object.keys(votes)])) {
    refs.push(doc(db, "players", id), doc(db, "answers", id), doc(db, "votes", id), doc(db, "turns", id));
  }
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit();
  }
  const b = writeBatch(db);
  b.set(secretRef(), { subjects: [], used: [], hintFrom: null, hints: [] });
  b.set(stateRef(), { phase: "lobby", perPerson: perPerson(), roundNo: 0, round: null });
  await b.commit();
}

/* ---------------- イベント ---------------- */
let busy = false;
document.addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t || busy) return;
  const run = async fn => { busy = true; try { await fn(); } catch (err) { console.error(err); alert("保存できませんでした。通信状況を確認して、もう一度押してください。"); } finally { busy = false; render(); } };

  // 参加者
  if (t.id === "startAnswer") {
    const v = (document.getElementById("nick")?.value || "").trim();
    if (!v) { local.error = "ニックネームを入れてください"; lastHTML = ""; return render(); }
    if (Object.values(players).some(p => p.nickname === v)) { local.error = "同じ名前の人がいます。少し変えてください"; lastHTML = ""; return render(); }
    local = { nick: v, qs: shuffle(QUESTIONS.map(q => q.id)).slice(0, Math.min(perPerson(), QUESTIONS.length)), idx: 0, answers: [], saving: false, error: "" };
    return render();
  }
  if (t.dataset.ans !== undefined) { local.answers[local.idx] = +t.dataset.ans; local.idx++; return render(); }
  if (t.id === "back") { local.idx = Math.max(0, local.idx - 1); return render(); }
  if (t.id === "reroll") {
    const taken = new Set(local.qs); const cand = QUESTIONS.map(q => q.id).filter(id => !taken.has(id));
    if (cand.length) { local.qs[local.idx] = cand[Math.floor(Math.random() * cand.length)]; local.answers[local.idx] = undefined; render(); }
    return;
  }
  if (t.id === "redo") { local = { nick: "", qs: [], idx: 0, answers: [], saving: false, error: "" }; lastHTML = ""; return render(); }
  if (t.id === "submit") {
    local.saving = true; local.error = ""; render();
    try {
      const b = writeBatch(db);
      b.set(doc(db, "answers", uid), { answers: local.qs.map((q, i) => ({ q, a: local.answers[i] })) });
      b.set(doc(db, "players", uid), { nickname: local.nick, joinedAt: Date.now() });
      await b.commit();
    } catch (err) { console.error(err); local.error = "登録できませんでした。もう一度押してください。"; }
    local.saving = false; return render();
  }
  if (t.dataset.vote) {
    const r = state?.round; if (!r || state.phase !== "question") return;
    return run(() => setDoc(doc(db, "votes", uid), { round: r.id, pick: t.dataset.vote }));
  }

  // 司会
  if (t.id === "login") return run(() => signInWithPopup(auth, new GoogleAuthProvider()));
  if (t.id === "logout") return run(() => signOut(auth));
  if (!isHost) return;
  if (t.id === "perMinus") return run(() => patchState({ perPerson: Math.max(1, perPerson() - 1) }));
  if (t.id === "perPlus") return run(() => patchState({ perPerson: Math.min(10, perPerson() + 1) }));
  if (t.id === "begin" || t.id === "next") return run(nextRound);
  if (t.id === "close") return run(reveal);
  if (t.id === "toLobby") return run(() => patchState({ phase: "lobby", round: null }));
  if (t.id === "abort") return run(abortGame);
  if (t.id === "hint") return run(showHint);
  if (t.id === "reset") return run(resetAll);
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "nick") document.getElementById("startAnswer")?.click(); });

/* ---------------- 購読 ---------------- */
const mapOf = s => { const o = {}; s.docs.forEach(d => o[d.id] = d.data()); return o; };
const fail = err => { console.error(err); };
function subscribe() {
  unsubs.forEach(u => u()); unsubs = [];
  unsubs.push(onSnapshot(stateRef(), s => { state = s.exists() ? s.data() : null; ready.state = true; render(); }, fail));
  unsubs.push(onSnapshot(collection(db, "players"), s => { players = mapOf(s); ready.players = true; render(); }, fail));
  if (MODE === "host") {
    unsubs.push(onSnapshot(secretRef(), s => { secret = s.exists() ? s.data() : null; render(); }, fail));
    unsubs.push(onSnapshot(collection(db, "answers"), s => { answers = mapOf(s); render(); }, fail));
    unsubs.push(onSnapshot(collection(db, "votes"), s => { votes = mapOf(s); render(); }, fail));
  } else {
    unsubs.push(onSnapshot(doc(db, "turns", uid), s => { myTurn = s.exists() ? s.data() : null; render(); }, fail));
    unsubs.push(onSnapshot(doc(db, "votes", uid), s => { myVote = s.exists() ? s.data() : null; render(); }, fail));
  }
}

onAuthStateChanged(auth, async user => {
  unsubs.forEach(u => u()); unsubs = [];
  ready = { state: false, players: false };
  if (MODE === "player") {
    if (!user) { try { await signInAnonymously(auth); } catch (e) { console.error(e); authState = "error"; render(); } return; }
    uid = user.uid; authState = "ok"; subscribe(); return render();
  }
  // 司会
  if (!user || user.isAnonymous) { authState = "needLogin"; return render(); }
  uid = user.uid; email = user.email;
  try {
    isHost = (await getDoc(doc(db, "admins", email))).exists();
  } catch (e) { console.error(e); isHost = false; }
  authState = isHost ? "ok" : "notHost";
  if (isHost) subscribe();
  render();
});

function render() { setHTML(MODE === "host" ? hostView() : playerView()); }
render();
