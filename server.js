const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

// Генерация traceparent (стандарт W3C)
function generateTraceparent() {
    const version = '00';
    const traceId = require('crypto').randomBytes(16).toString('hex');
    const parentId = require('crypto').randomBytes(8).toString('hex');
    const flags = '01';
    return `${version}-${traceId}-${parentId}-${flags}`;
}

async function makeRequest(url, method, body = null, cookieString = '', extraHeaders = {}) {
    // Полные заголовки, как в вашем HAR
    const headers = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'es-VE,es;q=0.9,en-US;q=0.8,en;q=0.7,es-MX;q=0.6',
        'content-type': 'application/json',
        'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'origin': 'https://www.bybit.com',
        'referer': 'https://www.bybit.com/en/task-center/my_rewards',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'traceparent': generateTraceparent(),
        ...extraHeaders
    };
    if (cookieString) {
        headers['Cookie'] = cookieString;
    }

    const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = { raw: text.substring(0, 1000) };
    }
    return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        data
    };
}

app.post('/get-token', async (req, res) => {
    const { cookies, url, awardId, specCode } = req.body;
    const log = [];

    const addLog = (msg) => {
        console.log(msg);
        log.push(msg);
    };

    try {
        addLog('📥 Request received');
        addLog(`Cookies type: ${typeof cookies}`);

        if (!cookies || !url) {
            return res.status(400).json({ error: 'Missing cookies or url', log });
        }

        // Преобразуем куки в строку
        let cookieString = '';
        if (Array.isArray(cookies)) {
            cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        } else if (typeof cookies === 'string') {
            cookieString = cookies;
        } else {
            return res.status(400).json({ error: 'Invalid cookies format', log });
        }
        addLog(`Cookie string length: ${cookieString.length}`);
        if (cookieString.includes('secure-token=')) {
            addLog('✅ secure-token found');
        } else {
            addLog('❌ secure-token NOT found');
        }

        // --- ШАГ 1: Получаем список наград (если не передан awardId) ---
        let targetAwardId = awardId;
        let targetSpecCode = specCode !== undefined ? specCode : null;

        if (!targetAwardId) {
            addLog('No awardId, fetching list...');
            const listBody = {
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
            };
            const listRes = await makeRequest(
                'https://www.bybit.com/x-api/segw/awar/v1/awarding/search-together',
                'POST',
                listBody,
                cookieString
            );
            addLog(`List status: ${listRes.status}`);
            addLog(`List response preview: ${JSON.stringify(listRes.data).substring(0, 1000)}`);

            if (listRes.status !== 200) {
                return res.status(500).json({ error: 'List fetch failed', details: listRes.data, log });
            }
            if (listRes.data.ret_code !== undefined && listRes.data.ret_code !== 0) {
                return res.status(500).json({ error: `Bybit error: ${listRes.data.ret_msg}`, details: listRes.data, log });
            }

            const awards = listRes.data?.result?.awardings;
            if (!awards || awards.length === 0) {
                addLog('No awards found in response');
                return res.status(404).json({ error: 'No awards found', response: listRes.data, log });
            }

            const firstAward = awards[0];
            targetAwardId = firstAward.award_detail.id;
            targetSpecCode = firstAward.spec_code || null;
            addLog(`Selected awardId: ${targetAwardId}, specCode: ${targetSpecCode}`);
        } else {
            addLog(`Using provided awardId: ${targetAwardId}, specCode: ${targetSpecCode === null ? 'null' : targetSpecCode}`);
        }

        // --- ШАГ 2: Запрос на получение награды (получаем risk_token) ---
        addLog('Fetching award...');
        const awardBody = {
            awardID: targetAwardId,
            spec_code: targetSpecCode,
            is_reward_hub: true
        };
        const awardRes = await makeRequest(
            'https://www.bybit.com/x-api/segw/awar/v1/awarding',
            'POST',
            awardBody,
            cookieString
        );
        addLog(`Award status: ${awardRes.status}`);
        addLog(`Award response preview: ${JSON.stringify(awardRes.data).substring(0, 1000)}`);

        // Проверяем код возврата (может быть 409015 - это ок, там есть risk_token)
        const awardRetCode = awardRes.data.retCode !== undefined ? awardRes.data.retCode : awardRes.data.ret_code;
        if (awardRetCode !== undefined && awardRetCode !== 0 && awardRetCode !== 409015) {
            return res.status(500).json({ error: `Bybit error: ${awardRes.data.retMsg || awardRes.data.ret_msg}`, details: awardRes.data, log });
        }

        const riskToken = awardRes.data?.result?.risk_token || awardRes.data?.risk_token;
        if (!riskToken) {
            return res.status(500).json({ error: 'No risk_token in award response', response: awardRes.data, log });
        }
        addLog(`Risk token: ${riskToken.substring(0, 30)}...`);

        // --- ШАГ 3: Запрос risk/components (НОВЫЙ) ---
        addLog('Fetching risk components...');
        const componentsBody = { risk_token: riskToken };
        const componentsRes = await makeRequest(
            'https://www.bybit.com/x-api/user/public/risk/components',
            'POST',
            componentsBody,
            cookieString
        );
        addLog(`Components status: ${componentsRes.status}`);
        addLog(`Components response preview: ${JSON.stringify(componentsRes.data).substring(0, 1000)}`);

        const componentsRetCode = componentsRes.data.retCode !== undefined ? componentsRes.data.retCode : componentsRes.data.ret_code;
        if (componentsRetCode !== undefined && componentsRetCode !== 0) {
            return res.status(500).json({ error: `Risk components error: ${componentsRes.data.retMsg || componentsRes.data.ret_msg}`, details: componentsRes.data, log });
        }

        // --- ШАГ 4: Запрос face token (получаем финальную ссылку) ---
        addLog('Fetching face token...');
        const faceBody = { risk_token: riskToken };
        const faceRes = await makeRequest(
            'https://www.bybit.com/x-api/user/public/risk/face/token',
            'POST',
            faceBody,
            cookieString,
            { 'platform': 'pc' } // обязательный заголовок
        );
        addLog(`Face token status: ${faceRes.status}`);
        addLog(`Face token response preview: ${JSON.stringify(faceRes.data).substring(0, 1000)}`);

        const faceRetCode = faceRes.data.retCode !== undefined ? faceRes.data.retCode : faceRes.data.ret_code;
        if (faceRetCode !== undefined && faceRetCode !== 0) {
            return res.status(500).json({ error: `Face token error: ${faceRes.data.retMsg || faceRes.data.ret_msg}`, details: faceRes.data, log });
        }

        const finalUrl = faceRes.data?.result?.token_info?.token;
        if (!finalUrl) {
            return res.status(500).json({ error: 'No final URL in face token response', response: faceRes.data, log });
        }

        addLog('✅ Final URL obtained');
        res.json({ success: true, url: finalUrl, log });

    } catch (error) {
        addLog('💥 Fatal error: ' + error.toString());
        res.status(500).json({ error: error.message, log });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Service running on port ${PORT}`));
