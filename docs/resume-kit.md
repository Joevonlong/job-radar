# resume-kit integration

resume-kit is a separate tool; it is **not part of this repository**. Until `resume_kit_path` is set in `resume.yaml`, the "Tailor résumé" buttons (the one in the job detail header and the one in Telegram) are hidden; the export panel further down the job detail page stays and gives you the JD file. **Privacy:** the `/tailor` command you paste into a terminal makes Claude read your **complete résumé** and the job description, so both are sent to Anthropic; see [privacy.md](privacy.md).

"Tailor resume" on the job detail page hands the JD to resume-kit's `/tailor` skill, and the resulting PDF is attached back to the application record. Claude Code does not run inside the container; you paste the command into a terminal yourself.

## Configuration: `data/config/resume.yaml`

The paths, `claude_command` and `claude_args` are protected keys: the settings page shows them read-only, so set them by editing the file (see [configuration.md](configuration.md#protected-keys-edited-by-hand-only)).

| Key | Meaning |
|---|---|
| `resume_kit_path` | Local directory of resume-kit (absolute path); when null only the JD path is given, with no command |
| `master_resume_path` | Your master resume YAML (outside this repository); it is only written into the command, the system never reads it |
| `pdf_dir` | Directory holding the tailored PDFs; "Attach resume" accepts only files here; when null nothing can be attached |
| `jd_export_dir` | JD export directory, default `data/exports/jd` (relative to the project directory) |
| `jd_export_host_dir` | When running in Docker, the export directory as seen from the host (used in the command); default null |
| `claude_command` | Command that starts Claude Code in a terminal, default `claude` |
| `claude_args` | Extra arguments placed right after `claude_command` in the command, default `--disallowed-tools=WebFetch,WebSearch` (only letters, digits and `_ = , . : / -` and spaces are accepted) |

Changes to the file take effect the next time the detail page is opened (the web process re-reads it each time); the runner (Telegram buttons) picks it up through config hot-reload.

## Untrusted job text

The JD file contains text written by whoever posted the job. A posting can try to instruct the AI that reads the file ("ignore your instructions and ..."). Two things limit that: the exported file puts the posting inside an `<untrusted_job_posting>` block, with a note above it that the block is data and not instructions (a closing tag inside the posting is neutralised), and the command starts Claude Code with `claude_args`, which by default switches off its web tools so a posting cannot make it fetch a URL. The Bash tool stays available because resume-kit needs it to render the PDF. The panel also reminds you of this, and you stay in the loop: the command runs in your terminal, where Claude Code asks before it does anything not already allowed. Do not run it with permission checks turned off.

## Flow

1. Click "Tailor resume" on the detail page: it writes `<company>-<title>-<yyyy-mm-dd>.md` (YAML front matter: `job_id`, `company`, `role`/`title`, `url`, `apply_url`, `location`, `workplace`, `contract`, `language`, `salary`, `score`, `signals`; the body is the original JD text), and sets the application status to "Preparing" (statuses from "Applied" onward are never moved backward). Exporting again on the same day overwrites the same file; another job at the same company with the same title on the same day gets a `-<job_id>` suffix, so they do not overwrite each other.
2. The panel gives a command; click "Copy command" and paste it in a terminal:
   `cd <resume_kit_path> && claude "/tailor <jd path> master-resume=<master resume> exports-folder=<pdf_dir>"`
   (`/tailor` follows resume-kit's SKILL.md to generate the variant YAML, check it and export the PDF.)
3. Under "Attach resume" enter the file name (or choose from the dropdown) and save: the path must be inside `pdf_dir` (`..`, absolute paths outside the directory and symlinks pointing outside are all rejected), and the file must exist and be a `.pdf`. The detail page header shows "Resume: xxx.pdf".

The Telegram 📄 button goes through the same export function: it exports the JD, sets the status to "Preparing", and sends the command back as a separate message.

## Docker

`compose.yaml` mounts `./data/exports` into web and runner. The command has to be pasted into a terminal on the host, so set `jd_export_host_dir` to the absolute path of this directory on the host. `pdf_dir` must also be visible to the web container: mount its directory into the web container at the **same absolute path** (compose override), otherwise attaching a resume only works under `pnpm dev` / when running on the host.
