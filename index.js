const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');

const defaultExclude = new Set(['node_modules', '.git']);

const safeName = (name) => name.replace(/[^a-zA-Z0-9]/g, '_');

const formatSize = (bytes, humanReadable = true) => {
  if (!humanReadable) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

const formatDate = (date) => date.toISOString().split('T')[0];

async function scanFolder(
  dir,
  {
    baseName = path.basename(path.resolve(dir)),
    fileExtFilter = [],
    excludeNames = [],
    maxDepth = Infinity,
    folderColor = '#f9f',
    fileColor = '#bbf',
    largeFileColor = '#f99',
    showHidden = false,
    sortBy = 'name',
    nodeType = 'both',
    humanReadableSize = true,
    highlightKeywords = [],
    minFileSize = 0,
    collapseFolders = false,
  } = {}
) {
  const excludeSet = new Set([...defaultExclude, ...excludeNames]);
  const nodes = new Set();
  let flow = '';

  const sortItems = async (items, currentPath) => {
    if (sortBy === 'name') return items.sort((a, b) => a.localeCompare(b));
    if (sortBy === 'size' || sortBy === 'date') {
      const statsPromises = items.map(async (item) => {
        const stats = await fs.stat(path.join(currentPath, item));
        return { item, stats };
      });
      const itemsWithStats = await Promise.all(statsPromises);

      if (sortBy === 'size') {
        return itemsWithStats
          .sort((a, b) => b.stats.size - a.stats.size)
          .map(({ item }) => item);
      }

      if (sortBy === 'date') {
        return itemsWithStats
          .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
          .map(({ item }) => item);
      }
    }
    return items;
  };

  const walk = async (currentPath, parentName, depth = 0) => {
    if (depth > maxDepth) return { flow: '', folderCount: 0, fileCount: 0, totalSize: 0 };

    let items;
    try {
      items = await fs.readdir(currentPath);
    } catch {
      return { flow: '', folderCount: 0, fileCount: 0, totalSize: 0 };
    }

    items = items.filter((item) => {
      if (excludeSet.has(item)) return false;
      if (!showHidden && item.startsWith('.')) return false;
      return true;
    });

    items = await sortItems(items, currentPath);

    let localFlow = '';
    let folderCount = 0;
    let fileCount = 0;
    let totalSize = 0;

    for (const item of items) {
      const fullPath = path.join(currentPath, item);
      const nodeName = safeName(`${parentName}_${item}_${depth}`);

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stats.isFile() && stats.size < minFileSize) continue;

      const modified = formatDate(stats.mtime);
      const isHighlighted = highlightKeywords.some((kw) => item.toLowerCase().includes(kw.toLowerCase()));
      const highlightClass = isHighlighted ? 'highlight' : '';

      if (stats.isDirectory()) {
        const { flow: childFlow, folderCount: subFolders, fileCount: subFiles, totalSize: subSize } = await walk(fullPath, nodeName, depth + 1);

        folderCount += 1 + subFolders;
        fileCount += subFiles;
        totalSize += subSize;

        if ((nodeType === 'folder' || nodeType === 'both') && !nodes.has(nodeName)) {
          localFlow += `${parentName} --> ${nodeName}\n`;
          const collapseClass = collapseFolders ? 'collapse' : '';
          localFlow += `${nodeName}["📁 ${item} (${subFolders} folders, ${subFiles} files, ${formatSize(subSize, humanReadableSize)}, modified: ${modified})"]:::folder${collapseClass ? ',' + collapseClass : ''}${highlightClass ? ',' + highlightClass : ''}\n`;
          nodes.add(nodeName);
          localFlow += childFlow;
        }
      } else if (stats.isFile()) {
        const ext = path.extname(item);
        if (fileExtFilter.length && !fileExtFilter.includes(ext)) continue;

        fileCount++;
        totalSize += stats.size;

        if ((nodeType === 'file' || nodeType === 'both') && !nodes.has(nodeName)) {
          localFlow += `${parentName} --> ${nodeName}\n`;
          const size = formatSize(stats.size, humanReadableSize);
          const className = stats.size > 1024 ** 2 ? 'largeFile' : 'file';
          localFlow += `${nodeName}["📄 ${item} (${size}, modified: ${modified})"]:::${className}${highlightClass ? ',' + highlightClass : ''}\n`;
          nodes.add(nodeName);
        }
      }
    }

    return { flow: localFlow, folderCount, fileCount, totalSize };
  };

  flow += `${baseName}["📁 ${baseName}"]:::folder\n`;
  nodes.add(baseName);

  const { flow: subFlow, folderCount, fileCount, totalSize } = await walk(dir, baseName, 0);

  flow += subFlow;

  flow = flow.replace(
    `${baseName}["📁 ${baseName}"]:::folder`,
    `${baseName}["📁 ${baseName} (${folderCount} folders, ${fileCount} files, ${formatSize(totalSize, humanReadableSize)})"]:::folder`
  );

  flow += `
classDef folder fill:${folderColor},stroke:#333,stroke-width:2px,color:#333,font-weight:bold;
classDef file fill:${fileColor},stroke:#333,stroke-width:1px,color:#000;
classDef largeFile fill:${largeFileColor},stroke:#333,stroke-width:1px,color:#000,font-weight:bold;
classDef highlight fill:#0f0,stroke:#333,stroke-width:2px,color:#000,font-weight:bold;
classDef collapse fill:#eee,stroke:#666,stroke-dasharray: 5 5,color:#999;
`;

  return {
    chart: `graph TD\n${flow}`,
    stats: {
      folderCount,
      fileCount,
      totalSize,
      formattedSize: formatSize(totalSize, humanReadableSize),
    },
  };
}

async function saveFlowchart(content, filename = 'MyProject.mmd') {
  try {
    await fs.writeFile(filename, content, 'utf8');
    console.log(`Flowchart file successfully saved: ${filename}`);
  } catch (err) {
    console.error(`Failed to save file ${filename}: ${err.message}`);
  }
}

async function exportToImage(mmdFile, format = 'png') {
  return new Promise((resolve, reject) => {
    const output = mmdFile.replace(/\.mmd$/, `.${format}`);

    const width = 3840;
    const height = 2160;
    const scale = 3;

    const cmd = `mmdc -i "${mmdFile}" -o "${output}" --width ${width} --height ${height} --scale ${scale}`;

    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`Error exporting image: ${err.message}`);
        return reject(err);
      }
      if (stderr) console.error(`stderr: ${stderr}`);
      console.log(`Image exported to: ${output}`);
      resolve(output);
    });
  });
}

module.exports = {
  async init(dir = process.cwd(), options = {}) {
    const result = await scanFolder(dir, options);
    const flowchart = result.chart;

    if (options.outputFile) {
      const outputDir = options.outputDir || '.';
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, options.outputFile);
      await saveFlowchart(flowchart, outputPath);

      if (options.exportImageFormat) {
        await exportToImage(outputPath, options.exportImageFormat);
      }
    }

    return result;
  },
  scanFolder,
  saveFlowchart,
  exportToImage,
};
