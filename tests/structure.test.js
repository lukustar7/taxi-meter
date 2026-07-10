import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const projectRoot = new URL('../', import.meta.url);

async function readProjectFile(relativePath) {
    return readFile(new URL(relativePath, projectRoot), 'utf8');
}

describe('静态应用结构', () => {
    it('HTML 不包含内联 JavaScript 事件', async () => {
        const html = await readProjectFile('index.html');
        assert.doesNotMatch(html, /\son(?:click|change|input|submit)\s*=/i);
    });

    it('页面以 ES 模块方式加载唯一应用入口', async () => {
        const html = await readProjectFile('index.html');
        assert.match(html, /<script\s+type="module"\s+src="src\/app\.js"><\/script>/);
        assert.doesNotMatch(html, /script\.js/);
    });

    it('入口脚本引用的固定控件 ID 都存在于 HTML', async () => {
        const [html, app] = await Promise.all([
            readProjectFile('index.html'),
            readProjectFile('src/app.js')
        ]);
        const htmlIds = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]));
        const directIds = Array.from(app.matchAll(/getElementById\('([^']+)'\)/g), (match) => match[1]);
        const clickBindingIds = Array.from(
            app.matchAll(/\['([^']+)',\s*[A-Za-z_$][\w$]*\]/g),
            (match) => match[1]
        );

        [...new Set([...directIds, ...clickBindingIds])].forEach((id) => {
            assert.ok(htmlIds.has(id), `HTML 缺少入口脚本引用的 #${id}`);
        });
    });

    it('Service Worker 离线清单包含入口和业务模块', async () => {
        const worker = await readProjectFile('service-worker.js');
        assert.match(worker, /'\.\/src\/app\.js'/);
        assert.match(worker, /'\.\/src\/device\.js'/);
        assert.match(worker, /'\.\/src\/domain\.js'/);
        assert.match(worker, /cache\.startsWith\(CACHE_PREFIX\)/);
    });

    it('Service Worker 离线清单中的每个文件都真实存在', async () => {
        const worker = await readProjectFile('service-worker.js');
        const assetPaths = Array.from(
            worker.matchAll(/^\s+'(\.\/[^']+)'[,]?$/gm),
            (match) => match[1]
        ).filter((path) => path !== './');

        await Promise.all(assetPaths.map((path) => access(new URL(path, projectRoot))));
        assert.ok(assetPaths.length >= 10, '离线资源数量异常，可能未完整解析缓存清单');
    });
});
