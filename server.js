const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

app.post('/get-token', async (req, res) => {
    const { cookies, url, awardId, specCode } = req.body;
    const log = [];

    const addLog = (msg) => {
        console.log(msg);
        log.push(msg);
    };

    let browser = null;
    try {
        addLog('📥 Request received');
        addLog(`Cookies type: ${typeof cookies}`);

        if (!cookies || !url) {
            return res.status(400).json({ error: 'Missing cookies or url', log });
        }

        // Преобразуем куки в массив объектов (если пришли строкой)
        let cookieArray = cookies;
        if (typeof cookies === 'string') {
            // Пример: "name1=value1; name2=value2"
            cookieArray = cookies.split(';').map(pair => {
                const [name, value] = pair.trim().split('=');
                return { name, value, domain: '.bybit.com', path: '/' };
            }).filter(c => c.name && c.value);
            addLog(`Parsed ${cookieArray.length} cookies from string`);
        } else if (!Array.isArray(cookies)) {
            return res.status(400).json({ error: 'Invalid cookies format', log });
        }

        // Запускаем браузер
        addLog('🚀 Launching browser...');
browser = await puppeteer.launch({
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-http2' // отключаем HTTP/2
    ],
    headless: true,
    defaultViewport: null
});
addLog('✅ Browser launched');

        const page = await browser.newPage();

        // Устанавливаем куки (только для домена bybit.com)
        const bybitCookies = cookieArray.filter(c => 
            c.domain?.includes('bybit.com') || c.domain?.includes('bytick.com') || !c.domain
        );
        addLog(`🍪 Setting ${bybitCookies.length} cookies (filtered from ${cookieArray.length})`);
        await page.setCookie(...bybitCookies);

        // Переходим на страницу наград (нужен для контекста)
        addLog(`🌍 Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        addLog('✅ Page loaded');

        // Выполняем цепочку запросов внутри страницы
        addLog('⚙️ Executing page.evaluate...');
        const result = await page.evaluate(async (targetAwardId, targetSpecCode) => {
            const log = (msg) => console.log(`[Evaluate] ${msg}`);

            try {
                // --- ШАГ 1: Получаем список наград, если не передан awardId ---
                let awardId = targetAwardId;
                let specCode = targetSpecCode;

                if (!awardId) {
                    log('No awardId, fetching list...');
                    const listRes = await fetch('https://www.bybit.com/x-api/segw/awar/v1/awarding/search-together', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            pagination: { pageNum: 1, pageSize: 12 },
                            filter: {
                                awardType: 'AWARD_TYPE_UNKNOWN',
                                newOrderWay: true,
                                rewardStatus: 'REWARD_STATUS_DEFAULT',
                                getFirstAwardings: false,
                                simpleField: true,
                                allow_amount_multiple: true,
                                return_reward_packet: true,
                                return_transfer_award: true
                            }
                        }),
                        credentials: 'include'
                    });
                    const listData = await listRes.json();
                    log(`List status: ${listRes.status}`);
                    if (!listData.result?.awardings?.length) {
                        throw new Error('No awards found');
                    }
                    awardId = listData.result.awardings[0].award_detail.id;
                    specCode = listData.result.awardings[0].spec_code || null;
                    log(`Selected awardId: ${awardId}, specCode: ${specCode}`);
                } else {
                    log(`Using provided awardId: ${awardId}, specCode: ${specCode}`);
                }

                // --- ШАГ 2: Запрос на получение награды ---
                log('Fetching award...');
                const awardRes = await fetch('https://www.bybit.com/x-api/segw/awar/v1/awarding', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        awardID: awardId,
                        spec_code: specCode,
                        is_reward_hub: true
                    }),
                    credentials: 'include'
                });
                const awardData = await awardRes.json();
                log(`Award status: ${awardRes.status}`);
                log(`Award response: ${JSON.stringify(awardData).substring(0, 200)}`);

                const riskToken = awardData?.result?.risk_token || awardData?.risk_token;
                if (!riskToken) {
                    throw new Error('No risk token in award response');
                }

                // --- ШАГ 3: Запрос face token ---
                log('Fetching face token...');
                const faceRes = await fetch('https://www.bybit.com/x-api/user/public/risk/face/token', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json;charset=UTF-8',
                        'platform': 'pc'
                    },
                    body: JSON.stringify({ risk_token: riskToken }),
                    credentials: 'include'
                });
                const faceData = await faceRes.json();
                log(`Face token status: ${faceRes.status}`);
                log(`Face token response: ${JSON.stringify(faceData).substring(0, 200)}`);

                const finalUrl = faceData?.result?.token_info?.token;
                if (!finalUrl) {
                    throw new Error('No final URL in face token response');
                }

                log('✅ Final URL obtained');
                return finalUrl;
            } catch (e) {
                log(`Critical error: ${e}`);
                return { error: e.toString() };
            }
        }, awardId || null, specCode !== undefined ? specCode : null);

        await browser.close();
        addLog('🔒 Browser closed');

        if (result && result.error) {
            addLog('❌ Error from evaluate: ' + result.error);
            res.status(500).json({ error: result.error, log });
        } else if (result) {
            addLog('🎉 Final URL: ' + result.substring(0, 50) + '...');
            res.json({ success: true, url: result, log });
        } else {
            addLog('❌ No result');
            res.status(500).json({ error: 'Failed to get URL', log });
        }

    } catch (error) {
        addLog('💥 Fatal error: ' + error.toString());
        if (browser) await browser.close();
        res.status(500).json({ error: error.message, log });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Service running on port ${PORT}`));
