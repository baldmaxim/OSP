-- Несколько объектов на пользователя.
--
-- Раньше сотрудник был привязан ровно к одному объекту через user_roles.object_id
-- (NULL = офис, видит всё). Теперь один пользователь может относиться к нескольким
-- объектам — добавляем массив object_ids. Старую колонку object_id НЕ удаляем
-- (обратная совместимость/откат), но код с этого момента читает/пишет object_ids.
--
-- Семантика прежняя: пустой массив = офис (видит все объекты); непустой = видит
-- только перечисленные объекты. FK на элементы массива Postgres не поддерживает —
-- «висячие» id (после удаления объекта) просто не совпадут ни с чем и отфильтруются.

ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS object_ids UUID[] NOT NULL DEFAULT '{}';

-- Переносим уже назначенный одиночный объект в массив (одноразово, идемпотентно).
UPDATE user_roles
SET object_ids = ARRAY[object_id]
WHERE object_id IS NOT NULL
  AND (object_ids IS NULL OR array_length(object_ids, 1) IS NULL);

-- GIN-индекс для быстрых проверок вхождения (object_ids @> ARRAY[...]/&&).
CREATE INDEX IF NOT EXISTS idx_user_roles_object_ids ON user_roles USING GIN (object_ids);

COMMENT ON COLUMN user_roles.object_ids IS 'Объекты, к которым привязан сотрудник. Пустой массив = офис (видит все объекты). Заменяет одиночный object_id.';
