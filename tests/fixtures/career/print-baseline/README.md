# Resume print baseline

Each document has normalized extracted text (`<theme>.<sample>.txt`) and a page count in `pages.json`. These files are generated on Linux with the runner image.

Run `scripts/career-print-baseline-linux.sh <output-directory>` from the repository root. The script prints PDFs and text into that output directory and compares them with this directory; differences exit with status 1. Review the output, then copy the approved text files and `pages.json` here manually. The script never updates this baseline.

Every baseline change must be explained difference by difference in the PR and approved in review. Never just replace the baseline with new output.
