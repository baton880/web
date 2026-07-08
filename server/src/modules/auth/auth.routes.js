import { Router } from 'express' // Роутер
import bcrypt from 'bcrypt' // Хеширование паролей
import jwt from 'jsonwebtoken' // Токены
import prisma from '../../database.js' //БД
import { createTransporter, isSmtpConfigured } from '../../utils/smtp.js'
import { SECRET_KEY } from '../../middleware/auth.js'

const router = Router()
const TOKEN_COOKIE_NAME = 'token'
const DEFAULT_FRONTEND_URL = 'https://vi-korm.ru'

function getFrontendUrl() {
  return (
    process.env.FRONTEND_URL ||
    process.env.APP_BASE_URL ||
    process.env.SITE_URL ||
    DEFAULT_FRONTEND_URL
  ).replace(/\/+$/, '')
}

function getAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}

// ============== Авторизация ==============

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body

    const user = await prisma.user.findUnique({ where: { username } })
    if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' })

    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) return res.status(401).json({ error: 'Неверный логин или пароль' })

    // Генерируем токен на 24 часа
    const token = jwt.sign({ id: user.id, role: user.role }, SECRET_KEY, { expiresIn: '24h' })
    
    // Устанавливаем токен в cookie для доступа к защищенным страницам
    res.cookie(TOKEN_COOKIE_NAME, token, getAuthCookieOptions())
    
    // Возвращаем токен и роль, чтобы фронтенд знал, какие вкладки показывать
    res.json({ token, role: user.role }) 
  } catch (error) {
    console.error('[Login Error]:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

// Выход из системы (очистка cookie)
router.post('/logout', (req, res) => {
  const { maxAge, ...clearCookieOptions } = getAuthCookieOptions()
  res.clearCookie(TOKEN_COOKIE_NAME, clearCookieOptions)
  res.json({ status: 'ok', message: 'Вы успешно вышли из системы' })
})

// ==================== СБРОС ПАРОЛЯ ====================

// 1. Запрос на сброс (Юзер вводит логин)
router.post('/forgot-password', async (req, res) => {
  try {
    const { username } = req.body

    if (!username) {
      return res.status(400).json({ error: 'Укажите логин' })
    }

    const user = await prisma.user.findUnique({ where: { username } })
    
    // Если юзер не найден ИЛИ у него нет email в базе
    // Отвечаем одинаково, чтобы не давать хакерам информацию
    if (!user || !user.email) {
      return res.json({ 
        status: 'ok', 
        message: 'Инструкция отправлена на email' 
      })
    }

    if (!isSmtpConfigured()) {
      console.error('[Ошибка /forgot-password]: SMTP не настроен')
      return res.status(500).json({ error: 'SMTP не настроен. Проверьте SMTP_HOST, SMTP_USER и SMTP_PASS' })
    }

    // Секрет из ключа + текущего пароля (ссылка сгорит после смены пароля)
    const secret = SECRET_KEY + user.password
    const token = jwt.sign({ id: user.id, username: user.username }, secret, { expiresIn: '15m' })

    const frontendUrl = getFrontendUrl()
    const resetParams = new URLSearchParams({
      token,
      id: String(user.id)
    })
    const resetLink = `${frontendUrl}/reset-password?${resetParams.toString()}`

    // Отправляем реальное письмо на привязанный email
    const transporter = createTransporter()
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: user.email,
      subject: 'Восстановление пароля',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Сброс пароля</h2>
          <p>Был запрошен сброс пароля для пользователя: <b>${user.username}</b></p>
          <p>Ссылка действительна <b>15 минут</b>.</p>
          <a href="${resetLink}" style="display:inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Сбросить пароль</a>
        </div>
      `
    })

    console.log(`[СБРОС ПАРОЛЯ] Письмо отправлено на ${user.email} для логина ${user.username}`)
    
    res.json({ 
      status: 'ok', 
      message: 'на почту отправлена инструкция по сбросу пароля' 
    })

  } catch (error) {
    console.error('[Ошибка /forgot-password]:', error)
    res.status(500).json({ error: 'Ошибка сервера при отправке письма' })
  }
})

// 2. Установка нового пароля
router.post('/reset-password', async (req, res) => {
  try {
    const { id, token, newPassword } = req.body

    if (!id || !token || !newPassword) {
      return res.status(400).json({ error: 'Не все данные переданы' })
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' })
    }

    const user = await prisma.user.findUnique({ where: { id: parseInt(id) } })
    if (!user) {
      return res.status(400).json({ error: 'Пользователь не найден' })
    }

    const secret = SECRET_KEY + user.password

    try {
      jwt.verify(token, secret)
    } catch (err) {
      return res.status(400).json({ error: 'Ссылка устарела или уже была использована' })
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10)

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedNewPassword }
    })

    res.json({ status: 'ok', message: 'Пароль успешно изменен. Теперь можно войти.' })

  } catch (error) {
    console.error('[Ошибка /reset-password]:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

export default router
