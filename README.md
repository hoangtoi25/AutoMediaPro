# AutoMediaPro

Standalone Puppeteer automation tool for Google Labs ImageFX (Flow) — không cần extension.

## Cài đặt

```bash
cd AutoMediaPro
npm install
```

## Sử dụng

### Bước 1: Login Google (chỉ cần 1 lần)

```bash
node index.js --login
```

Chrome sẽ mở ra. Đăng nhập Google bình thường, rồi đóng Chrome.

### Bước 2: Chạy automation

```bash
# Dùng file .txt
node index.js --prompts ./prompts/sample.txt --folder "MyProject"

# Dùng file .md
node index.js --prompts ./prompts/stickman.md --folder "Stickman"
```

Ảnh sẽ được tải về `~/Downloads/<folder>/`.

### Cách khác: Dùng Chrome đang mở

Nếu bạn đã có Chrome đang mở với remote debugging:

```bash
# Terminal 1: Mở Chrome
node launch-chrome.js

# Terminal 2: Chạy automation
node index.js --prompts ./prompts/sample.txt --folder "MyProject"
```

## Options

| Option | Mô tả |
|--------|--------|
| `--prompts, -p` | File chứa prompts (`.txt` hoặc `.md`) |
| `--folder, -f` | Tên folder download (default: AutoMedia) |
| `--retries, -r` | Số lần retry tối đa (default: 2) |
| `--new-chrome` | Bắt buộc mở Chrome mới |
| `--login` | Mở Chrome để login (chạy 1 lần đầu) |

## Hỗ trợ file prompts

### File `.txt`
```text
# Comment - bị bỏ qua
1. First prompt text here
2. Second prompt text here
Prompt without number
```
- Mỗi dòng = 1 prompt
- Dòng bắt đầu bằng `#` = comment

### File `.md`
```markdown
# Project Title (bị bỏ qua)

Mô tả dự án (bị bỏ qua nếu có prompt đánh số)

---

## Section 1

1. First prompt text here
2. Second prompt text here

## Section 2

3. Third prompt text here
```
- Headers (`#`), horizontal rules (`---`), code blocks → tự động bỏ qua
- Markdown formatting (`**bold**`, `*italic*`, `[links](url)`) → tự động strip
- Nếu có prompt đánh số (`1. text`) → chỉ lấy những dòng đó
- Nếu không có số → lấy tất cả dòng non-header

## Nguyên lý hoạt động

1. Connect vào Chrome thật (đã login Google) qua Remote Debugging Protocol
2. Navigate đến ImageFX page
3. Tự động đóng popup "Welcome to Flow!" + click "Dự án mới"
4. Với mỗi prompt:
   - Tìm ô nhập Slate.js editor
   - Clear + type prompt bằng Puppeteer keyboard API (trusted events)
   - Click nút Generate
   - Poll chờ ảnh mới xuất hiện trên DOM
   - Fetch ảnh qua page context (kế thừa cookies) → lưu file
5. Log kết quả ra terminal

## Cấu trúc project

```
AutoMediaPro/
├── index.js           # CLI entry point
├── browser.js         # Chrome connection manager (connect/launch)
├── generator.js       # Core pipeline: submit → wait → download
├── page-actions.js    # DOM interactions via Puppeteer API
├── downloader.js      # Image download via page fetch → fs
├── config.js          # Selectors, timing, paths
├── logger.js          # Colored CLI output
├── launch-chrome.js   # Standalone Chrome launcher
└── prompts/
    ├── sample.txt     # Example .txt prompts
    └── sample-doc.md  # Example .md prompts
```
