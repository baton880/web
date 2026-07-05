import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Начинаем создание пользователей...');

  // Массив пользователей, которых мы хотим создать
  const usersToCreate = [
    {
      username: 'admin',
      password: 'KorovkiTOP',
      role: 'ADMIN'
    },
    {
      username: 'dir',
      password: 'SrostkiFARM',
      role: 'DIRECTOR'
    },
    {
      username: 'guest',
      password: 'pass123',
      role: 'GUEST'
    }
  ];

  for (const userData of usersToCreate) {
    // Хешируем пароль (10 - это стандартная сложность соли)
    const hashedPassword = await bcrypt.hash(userData.password, 10);
    
    // Используем upsert для безопасного добавления/обновления
    const user = await prisma.user.upsert({
      where: { username: userData.username },
      update: {
        password: hashedPassword,
        role: userData.role
      },
      create: {
        username: userData.username,
        password: hashedPassword,
        role: userData.role
      }
    });

    console.log(`✅ Пользователь ${user.username} с ролью ${user.role} готов к работе!`);
  }

  await prisma.telemetrySettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      batchStartThresholdKg: 30,
      leftoverThresholdKg: 50,
      unloadDropThresholdKg: 500,
      unloadMinPeakKg: 400,
      unloadUpdateDeltaKg: 1,
      anomalyThresholdKg: 200,
      anomalyConfirmDeltaKg: 40,
      anomalyConfirmPackets: 3
    }
  });

  console.log('✅ Настройки телеметрии инициализированы');
  
  console.log('🎉 Все пользователи успешно добавлены в базу!');
}

main()
  .catch((e) => {
    console.error('❌ Ошибка при создании пользователей:', e);
    process.exit(1);
  })
  .finally(async () => {
    // Обязательно отключаемся от базы после завершения
    await prisma.$disconnect();
  });
