const ComicScraper = require('./scraper');
const GoogleDrive = require('./googleDrive');
const Database = require('./database');
const ComicCompressor = require('./comicCompressor');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseIssueNumber(title) {
  const match = title.match(/(?:#|\bv|vol\.?|issue\s*)?\s*(\d+(?:\.\d+)?)/i);
  return match ? parseFloat(match[1]) : null;
}

const PullListManager = {
  async scanPullList(user, autoDownload = false) {
    if (!user || !user.driveFolderId) {
      throw new Error('Google Drive comic folder is not configured.');
    }

    const pullList = Database.getPullList(user.id);
    const seriesList = pullList.series || [];
    if (seriesList.length === 0) {
      return {
        checked: 0,
        downloaded: 0,
        skipped: 0,
        errors: 0,
        issues: [],
        message: 'No series currently on your pull list.'
      };
    }

    const ownedComics = Database.getUserComics(user.id);
    const ownedTitles = new Set(ownedComics.map((c) => (c.title || '').toLowerCase().trim()));

    const issues = [];
    let downloadedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const downloadedFileIds = [];

    for (const series of seriesList) {
      try {
        const searchResults = await ComicScraper.searchGetComics(series);
        for (const item of searchResults) {
          const itemTitleLower = item.title.toLowerCase().trim();
          const alreadyOwned = ownedTitles.has(itemTitleLower) ||
            ownedComics.some((c) => {
              if (c.series && c.series.toLowerCase() === series.toLowerCase()) {
                const num1 = parseIssueNumber(c.title);
                const num2 = parseIssueNumber(item.title);
                return num1 !== null && num2 !== null && num1 === num2;
              }
              return false;
            });

          if (alreadyOwned) {
            skippedCount++;
            continue;
          }

          const issueRecord = {
            series,
            title: item.title,
            chapterUrl: item.chapterUrl,
            size: item.size || '',
            year: item.year || '',
            status: 'pending'
          };

          if (autoDownload) {
            const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const tempArchive = path.join(os.tmpdir(), `cmx_pl_${stamp}.archive`);
            const tempOutput = path.join(os.tmpdir(), `cmx_pl_${stamp}.cbz`);
            try {
              const dlResult = await ComicScraper.downloadIssueToFile(item.chapterUrl, tempArchive);
              let finalSource = tempArchive;
              let finalSize = dlResult.size;
              let coverJpeg = null;
              try {
                const compResult = await ComicCompressor.compressArchiveFileToFile(tempArchive, tempOutput, { quality: 75 });
                if (compResult.compressedSize > 0 && compResult.compressedSize < dlResult.size) {
                  finalSource = tempOutput;
                  finalSize = compResult.compressedSize;
                }
                if (compResult.coverJpeg) {
                  coverJpeg = compResult.coverJpeg;
                }
              } catch (compErr) {
                console.warn('[PullList] Compression skipped:', compErr.message);
              }
              if (!coverJpeg) {
                try {
                  const extracted = await ComicCompressor.extractCoverThumbnail(finalSource, { maxHeight: 512, quality: 85 });
                  if (extracted && extracted.coverJpeg) {
                    coverJpeg = extracted.coverJpeg;
                  }
                } catch (e) {}
              }
              const saved = await GoogleDrive.uploadComicFile(user, finalSource, dlResult.fileName, series, dlResult.coverUrl, null, null, null, coverJpeg);
              issueRecord.status = 'downloaded';
              issueRecord.size = finalSize;
              downloadedCount++;
              if (saved && saved.googleFileId) downloadedFileIds.push(saved.googleFileId);
              ownedTitles.add(itemTitleLower);
            } catch (dlErr) {
              issueRecord.status = 'error';
              issueRecord.error = dlErr.message;
              errorCount++;
            } finally {
              for (const p of [tempArchive, tempOutput]) {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
              }
            }
          }

          issues.push(issueRecord);
        }
      } catch (err) {
        errorCount++;
        console.warn(`[PullList] Error checking series "${series}":`, err.message);
      }
    }

    const summary = {
      checked: seriesList.length,
      downloaded: downloadedCount,
      skipped: skippedCount,
      errors: errorCount,
      issues,
      timestamp: new Date().toISOString(),
      message: `Checked ${seriesList.length} series: found ${issues.length} new issue(s).`
    };

    // Refresh the library so newly downloaded issues appear immediately.
    if (autoDownload && downloadedCount > 0) {
      try {
        const scan = await GoogleDrive.syncLibrary(user, { protectFileIds: downloadedFileIds });
        summary.libraryCount = scan.count;
      } catch (scanErr) {
        console.warn('[PullList] Post-download library scan failed:', scanErr.message);
      }
    }

    Database.updatePullListResults(user.id, summary);
    return summary;
  }
};

module.exports = PullListManager;
