import { Router } from 'express';
import prisma from '../../database.js';
import { requireReadAccess, requireWriteAccess } from '../../middleware/auth.js';
import { buildSenderEnvelope, createTransporter, isSmtpConfigured } from '../../utils/smtp.js';

const router = Router();
const DIGEST_SETTINGS_ID = 1;
const DEFAULT_SETTINGS = {
    id: DIGEST_SETTINGS_ID,
    enabled: false,
    senderEmail: '',
    sendTime: '08:00',
    timezone: 'Asia/Barnaul',
    recipients: [],
    updatedAt: '',
};

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function isValidSendTime(value) {
    return /^\d{2}:\d{2}$/.test(String(value || '').trim());
}

function parseRecipients(value) {
    if (!value) return [];

    if (Array.isArray(value)) {
        return value.map(normalizeEmail).filter(Boolean);
    }

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(normalizeEmail).filter(Boolean) : [];
        } catch (error) {
            return [];
        }
    }

    return [];
}

function serializeSettings(row) {
    if (!row) {
        return { ...DEFAULT_SETTINGS };
    }

    return {
        id: row.id,
        enabled: Boolean(row.enabled),
        senderEmail: row.senderEmail || '',
        sendTime: row.sendTime || '08:00',
        timezone: row.timezone || 'Asia/Barnaul',
        recipients: parseRecipients(row.recipientsJson),
        lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : '',
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : '',
    };
}

async function ensureDigestSettings() {
    const existing = await prisma.digestSettings.findUnique({
        where: { id: DIGEST_SETTINGS_ID }
    });

    if (existing) {
        return existing;
    }

    return prisma.digestSettings.create({
        data: {
            id: DIGEST_SETTINGS_ID,
            enabled: false,
            senderEmail: '',
            sendTime: '08:00',
            timezone: 'Asia/Barnaul',
            recipientsJson: '[]'
        }
    });
}

function validateDigestSettings(payload) {
    const senderEmail = normalizeEmail(payload.senderEmail);
    const sendTime = String(payload.sendTime || '').trim();
    const timezone = String(payload.timezone || '').trim();
    const recipients = [...new Set(parseRecipients(payload.recipients))];
    const enabled = Boolean(payload.enabled);

    if (!senderEmail || !isValidEmail(senderEmail)) {
        return { error: 'Укажите корректный email отправителя' };
    }

    if (!isValidSendTime(sendTime)) {
        return { error: 'Укажите корректное время отправки в формате ЧЧ:ММ' };
    }

    if (!timezone) {
        return { error: 'Укажите часовой пояс' };
    }

    if (!recipients.length) {
        return { error: 'Добавьте хотя бы одного получателя' };
    }

    if (recipients.some((email) => !isValidEmail(email))) {
        return { error: 'Один или несколько email получателей заполнены некорректно' };
    }

    return {
        value: {
            enabled,
            senderEmail,
            sendTime,
            timezone,
            recipients,
        }
    };
}

router.get('/', requireReadAccess, async (req, res) => {
    try {
        const row = await ensureDigestSettings();
        res.json(serializeSettings(row));
    } catch (error) {
        console.error('[Ошибка GET /digest-settings]:', error);
        res.status(500).json({ error: 'Не удалось получить настройки дайджеста' });
    }
});

router.put('/', requireWriteAccess, async (req, res) => {
    try {
        const validation = validateDigestSettings(req.body || {});
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }

        const nextSettings = validation.value;
        const row = await prisma.digestSettings.upsert({
            where: { id: DIGEST_SETTINGS_ID },
            create: {
                id: DIGEST_SETTINGS_ID,
                enabled: nextSettings.enabled,
                senderEmail: nextSettings.senderEmail,
                sendTime: nextSettings.sendTime,
                timezone: nextSettings.timezone,
                recipientsJson: JSON.stringify(nextSettings.recipients)
            },
            update: {
                enabled: nextSettings.enabled,
                senderEmail: nextSettings.senderEmail,
                sendTime: nextSettings.sendTime,
                timezone: nextSettings.timezone,
                recipientsJson: JSON.stringify(nextSettings.recipients)
            }
        });

        res.json({
            status: 'ok',
            message: 'Настройки дайджеста сохранены',
            settings: serializeSettings(row)
        });
    } catch (error) {
        console.error('[Ошибка PUT /digest-settings]:', error);
        res.status(500).json({ error: 'Не удалось сохранить настройки дайджеста' });
    }
});

router.post('/test', requireWriteAccess, async (req, res) => {
    try {
        const validation = validateDigestSettings(req.body || {});
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }

        if (!isSmtpConfigured()) {
            return res.status(500).json({ error: 'SMTP не настроен. Проверьте SMTP_HOST, SMTP_USER и SMTP_PASS' });
        }

        const settings = validation.value;
        const transporter = createTransporter();
        const sentAt = new Date();
        const senderEnvelope = buildSenderEnvelope(settings.senderEmail, 'Дайджест по кормлению');

        await transporter.sendMail({
            from: senderEnvelope.from,
            ...(senderEnvelope.replyTo ? { replyTo: senderEnvelope.replyTo } : {}),
            to: settings.recipients.join(', '),
            subject: 'Тест дайджеста по кормлению',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>Тестовая отправка дайджеста</h2>
                    <p>Это тестовое письмо для проверки настроек ежедневной рассылки.</p>
                    <ul>
                        <li><b>Статус:</b> ${settings.enabled ? 'включен' : 'выключен'}</li>
                        <li><b>Отправитель в настройках:</b> ${settings.senderEmail}</li>
                        <li><b>Время:</b> ${settings.sendTime}</li>
                        <li><b>Часовой пояс:</b> ${settings.timezone}</li>
                        <li><b>Получатели:</b> ${settings.recipients.join(', ')}</li>
                    </ul>
                    <p><b>Время отправки теста:</b> ${sentAt.toLocaleString('ru-RU')}</p>
                </div>
            `
        });

        res.json({
            status: 'ok',
            message: `Тестовое письмо отправлено: ${settings.recipients.join(', ')}`,
            sentAt: sentAt.toISOString()
        });
    } catch (error) {
        console.error('[Ошибка POST /digest-settings/test]:', error);
        res.status(500).json({ error: 'Не удалось отправить тестовое письмо' });
    }
});

export default router;
