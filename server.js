const express = require('express');
const app = express();

app.use(express.json());

// Вспомогательная функция для генерации traceparent (стандарт W3C)
function generateTraceparent() {
    const version = '00';
    const traceId = require('crypto').randomBytes(16).toString('hex');
    const parentId = require('crypto').randomBytes(8).toString('hex');
    const flags = '01';
    return `${version}-${traceId}-${parentId}-${flags}`;
}

// Функция для выполнения запроса с куками и заголовками
async function makeRequest(url, method, body = null, cookies = '', extraHeaders = {}) {
    const headers = {
        'accept': 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'origin': 'https://www.bybit.com',
        'referer': 'https://www.bybit.com/en/task-center/my_rewards',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'traceparent': generateTraceparent(),
        ...extraHeaders
    };
    if (cookies) {
        headers['Cookie'] = cookies;
    }

    const options = {
        method,
        headers,
        credentials: 'include' // в fetch Node.js это игнорируется, но оставим для совместимости
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = { raw: text };
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

        // Преобразуем куки в строку, если они массив
        let cookieString = '';
        if (Array.isArray(cookies)) {
            cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        } else if (typeof cookies === 'string') {
            cookieString = cookies;
        } else {
            return res.status(400).json({ error: 'Invalid cookies format', log });
        }

        addLog(`Cookie string length: ${cookieString.length}`);

        // --- ШАГ 1: Получаем список наград (если не передан awardId) ---
        let targetAwardId = awardId;
        let targetSpecCode = specCode || '';

        if (!targetAwardId) {
            addLog('No awardId, fetching list...');
            const listBody = {
                pagination: { pageNum: 1, pageSize: 12 },
                filter: {
                    awardType: 'AWARD_TYPE_UNKNOWN',
                    newOrderWay: true,
                    rewardBusinessLine: 'REWARD_BUSINESS_LINE_DEFAULT',
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
            if (listRes.status !== 200) {
                return res.status(500).json({ error: 'List fetch failed', details: listRes.data, log });
            }

            const firstAward = listRes.data?.result?.awardings?.[0];
            if (!firstAward) {
                return res.status(404).json({ error: 'No awards found', log });
            }
            targetAwardId = firstAward.award_detail.id;
            targetSpecCode = firstAward.spec_code || '';
            addLog(`Selected awardId: ${targetAwardId}, specCode: ${targetSpecCode}`);
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
        if (awardRes.status !== 200) {
            return res.status(500).json({ error: 'Award fetch failed', details: awardRes.data, log });
        }

        const riskToken = awardRes.data?.result?.risk_token || awardRes.data?.risk_token;
        if (!riskToken) {
            return res.status(500).json({ error: 'No risk_token in award response', response: awardRes.data, log });
        }
        addLog(`Risk token: ${riskToken.substring(0, 30)}...`);

        // --- ШАГ 3: Запрос face token (получаем финальную ссылку) ---
        addLog('Fetching face token...');
        const faceBody = { risk_token: riskToken };
        const faceRes = await makeRequest(
            'https://www.bybit.com/x-api/user/public/risk/face/token',
            'POST',
            faceBody,
            cookieString,
            { 'platform': 'pc' } // дополнительный заголовок
        );
        addLog(`Face token status: ${faceRes.status}`);
        if (faceRes.status !== 200) {
            return res.status(500).json({ error: 'Face token fetch failed', details: faceRes.data, log });
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