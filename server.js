const express = require('express');
const app = express();
app.use(express.json());

async function makeRequest(url, method, body = null, cookieString = '') {
    const headers = {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'referer': 'https://www.bybit.com/en/task-center/my_rewards',
    };
    if (cookieString) headers['Cookie'] = cookieString;

    const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    try {
        return { status: response.status, data: JSON.parse(text) };
    } catch {
        return { status: response.status, data: { raw: text.substring(0, 500) } };
    }
}

app.post('/get-token', async (req, res) => {
    const { cookies, url, awardId, specCode } = req.body;
    const log = [];
    const addLog = (msg) => { console.log(msg); log.push(msg); };

    try {
        addLog('📥 Request received');
        if (!cookies || !url) return res.status(400).json({ error: 'Missing cookies or url', log });

        const cookieString = Array.isArray(cookies) 
            ? cookies.map(c => `${c.name}=${c.value}`).join('; ') 
            : cookies;
        addLog(`Cookie string length: ${cookieString.length}`);

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
                'POST', listBody, cookieString
            );
            addLog(`List status: ${listRes.status}`);
            addLog(`List response preview: ${JSON.stringify(listRes.data).substring(0, 500)}`);

            if (listRes.status !== 200 || listRes.data.ret_code !== 0) {
                return res.status(500).json({ error: 'List fetch failed', details: listRes.data, log });
            }

            const awards = listRes.data?.result?.awardings;
            if (!awards || awards.length === 0) {
                return res.status(404).json({ error: 'No awards found', response: listRes.data, log });
            }

            const firstAward = awards[0];
            targetAwardId = firstAward.award_detail.id;
            targetSpecCode = firstAward.spec_code || '';
            addLog(`Selected awardId: ${targetAwardId}, specCode: ${targetSpecCode}`);
        }

        // Шаг 2: award
        addLog('Fetching award...');
        const awardBody = { awardID: targetAwardId, spec_code: targetSpecCode, is_reward_hub: true };
        const awardRes = await makeRequest('https://www.bybit.com/x-api/segw/awar/v1/awarding', 'POST', awardBody, cookieString);
        addLog(`Award status: ${awardRes.status}`);
        if (awardRes.status !== 200 || !awardRes.data?.result?.risk_token) {
            return res.status(500).json({ error: 'Award fetch failed', details: awardRes.data, log });
        }
        const riskToken = awardRes.data.result.risk_token;
        addLog(`Risk token: ${riskToken.substring(0, 30)}...`);

        // Шаг 3: face token
        addLog('Fetching face token...');
        const faceRes = await makeRequest(
            'https://www.bybit.com/x-api/user/public/risk/face/token',
            'POST',
            { risk_token: riskToken },
            cookieString,
            { 'platform': 'pc' }
        );
        addLog(`Face token status: ${faceRes.status}`);
        const finalUrl = faceRes.data?.result?.token_info?.token;
        if (!finalUrl) {
            return res.status(500).json({ error: 'No final URL', response: faceRes.data, log });
        }

        addLog('✅ Final URL obtained');
        res.json({ success: true, url: finalUrl, log });

    } catch (error) {
        addLog('💥 ' + error.toString());
        res.status(500).json({ error: error.message, log });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Service running'));
