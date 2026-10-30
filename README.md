# hx

Worker pool ของ Claude Code ที่รันบน Windows ได้โดยตรง ทำ GitHub issue ให้อัตโนมัติ
(เขียนใหม่โดยได้แนวคิดจาก [VocanicZ/Harness](https://github.com/VocanicZ/Harness))

ทุก issue ได้ git worktree แยกของตัวเอง และได้ **Claude session ใหม่** ระบบจะรันวนจน AI ทำงานจบ
(test → PR → merge → ปิด issue) โดยไม่ใช้ tmux และไม่อ่านหน้าจอ ใช้ `claude -p --output-format stream-json` แทน

## ต้องมี

- Node ≥ 23.6 (ไม่ต้องติดตั้ง dependency ใดๆ และไม่ต้อง build)
- `git`, `gh` (login แล้ว), `claude`

## ติดตั้ง

```bash
cd hx
npm link
```

## ใช้งาน

```bash
cd <repo ของคุณ>
hx init                 # สร้าง .hx/config.json และ label บน GitHub
hx status               # ดูว่ามี issue ไหนพร้อมทำ / รออยู่ / ติดอยู่
hx run --dry-run        # ดูว่าจะหยิบ issue ไหนบ้าง โดยยังไม่ทำอะไรจริง
hx run                  # ทำทุก issue ที่ทำได้ เสร็จแล้วจบ
hx run --watch          # รันค้างไว้ และหยิบ issue ใหม่เมื่อมีเพิ่ม
hx run --issue 12,15    # ทำเฉพาะ issue ที่ระบุ
hx usage --by issue     # ดู token ที่ใช้ (แยกตาม issue / model / day)
```

**issue ที่จะถูกหยิบ** ต้องเปิดอยู่ ติด label `ready-for-agent` ไม่มี label `agent-working` หรือ `agent-blocked`
และทุก issue ที่อยู่ใต้หัวข้อนี้ต้องปิดแล้ว:

```markdown
## Blocked by
#12
other-owner/other-repo#3
```

กด Ctrl+C หนึ่งครั้ง: หยุด session ทั้งหมด คืน issue กลับไป และเก็บ worktree ไว้ให้รันต่อครั้งหน้า

## Config (`.hx/config.json`)

| key | default | |
|---|---|---|
| `workers` | 2 | จำนวน session ที่รันพร้อมกัน |
| `model` | `sonnet` | model ที่ใช้ |
| `maxIterations` | 8 | จำนวนรอบสูงสุดต่อ issue ถ้าเกินจะติด label `agent-blocked` และคอมเมนต์เหตุผลไว้ |
| `turnTimeoutMinutes` | 45 | เวลาสูงสุดต่อรอบ |
| `worktreeRoot` | `<drive>:\hx-wt\<repo>` | ควรเป็น path สั้น เพราะ Windows จำกัดความยาว path |
| `claudeArgs` | `[]` | flag ที่จะส่งให้ `claude` เพิ่ม |

## ⚠️ ความปลอดภัย

Worker รันด้วย `--permission-mode bypassPermissions` แปลว่า AI จะรันคำสั่งใดๆ ใน worktree ได้เองโดยไม่ถามคุณ
และจะ push / merge เข้า branch หลักเอง **ควรลองกับ repo ทดสอบก่อน**

## เครดิต

แนวคิดหลักได้มาจาก [VocanicZ/Harness](https://github.com/VocanicZ/Harness) (MIT) ได้แก่ การเก็บ state ไว้บน GitHub issue,
รูปแบบ `## Blocked by`, worktree แยกต่อ issue, Ralph loop ที่จบด้วย `<promise>` และ prompt แยกตามบทบาท
ส่วนโค้ดของ hx เขียนขึ้นใหม่ทั้งหมด

## ไฟล์ที่สร้าง

- `.hx/usage.jsonl` เก็บ token ของทุกรอบ (input / cache read / cache write / output)
- `.hx/logs/issue-N.jsonl` เก็บ event ดิบจาก Claude ไว้ใช้ debug
