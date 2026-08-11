(() => {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DATA_KEY = "planner.v1.data";
  const SETTINGS_KEY = "planner.v1.settings";
  const MAX_TITLE_LENGTH = 120;
  const MAX_DESCRIPTION_LENGTH = 2000;
  const DEFAULT_CATEGORY_DEFINITIONS = [
    { id: "personal", name: "Личное", color: "#5f95d5" },
    { id: "family", name: "Семья", color: "#5eaa83" },
    { id: "work", name: "Работа", color: "#de786b" },
  ];
  const CATEGORY_COLORS = ["#b97970", "#7697ad", "#789faf", "#83a68c", "#c4a561", "#9984aa", "#938d82"];
  const RECORD_TYPES = new Set(["task", "event"]);
  const RECORD_STATUSES = new Set(["active", "archived", "trash"]);
  const FILTER_STATUSES = new Set(["active", "archived"]);
  const REPEAT_END_CONDITIONS = new Set(["date", "count", "never"]);

  class PlannerValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = "PlannerValidationError";
    }
  }

  class PlannerStorageError extends Error {
    constructor(message) {
      super(message);
      this.name = "PlannerStorageError";
    }
  }

  class PlannerStore {
    constructor(storage) {
      this.storage = storage;
      this.recovery = { data: null, settings: null };
      this.lastSaveError = null;
      this.data = this.loadData();
      this.settings = this.loadSettings();
    }

    getData() {
      return deepCopy(this.data);
    }

    getSettings() {
      return deepCopy(this.settings);
    }

    getRecoveryState() {
      return {
        data: this.recovery.data !== null,
        settings: this.recovery.settings !== null,
        saveError: this.lastSaveError,
      };
    }

    createRecord(input) {
      let createdRecord;

      this.updateData((draft) => {
        createdRecord = normalizeRecord(
          { ...input, id: createId("record"), createdAt: nowIso(), updatedAt: nowIso() },
          draft.categories,
        );
        draft.records.push(createdRecord);
      });

      return deepCopy(createdRecord);
    }

    replaceRecord(recordId, input) {
      let updatedRecord;

      this.updateData((draft) => {
        const index = draft.records.findIndex((record) => record.id === recordId);
        if (index === -1) {
          throw new PlannerValidationError("Запись для изменения не найдена.");
        }

        const existingRecord = draft.records[index];
        updatedRecord = normalizeRecord(
          {
            ...existingRecord,
            ...input,
            id: existingRecord.id,
            createdAt: existingRecord.createdAt,
            updatedAt: nowIso(),
          },
          draft.categories,
        );
        draft.records[index] = updatedRecord;
      });

      return deepCopy(updatedRecord);
    }

    createCategory(input) {
      let createdCategory;

      this.updateData((draft) => {
        createdCategory = normalizeCategory(
          { ...input, id: createId("category"), isDefault: false, createdAt: nowIso() },
          draft.categories,
        );
        draft.categories.push(createdCategory);
      });

      return deepCopy(createdCategory);
    }

    updateCategory(categoryId, input) {
      let updatedCategory;

      this.updateData((draft) => {
        const index = draft.categories.findIndex((category) => category.id === categoryId);
        if (index === -1) {
          throw new PlannerValidationError("Категория для изменения не найдена.");
        }

        const existingCategory = draft.categories[index];
        if (existingCategory.isDefault) {
          throw new PlannerValidationError("Стартовую категорию нельзя переименовать или изменить.");
        }

        updatedCategory = normalizeCategory(
          { ...existingCategory, ...input, id: existingCategory.id, isDefault: false, createdAt: existingCategory.createdAt },
          draft.categories,
          categoryId,
        );
        draft.categories[index] = updatedCategory;
      });

      return deepCopy(updatedCategory);
    }

    deleteCategory(categoryId) {
      this.updateData((draft) => {
        const category = draft.categories.find((item) => item.id === categoryId);
        if (!category) {
          throw new PlannerValidationError("Категория для удаления не найдена.");
        }
        if (category.isDefault) {
          throw new PlannerValidationError("Стартовую категорию нельзя удалить.");
        }
        if (draft.records.some((record) => record.categoryId === categoryId)) {
          throw new PlannerValidationError("Нельзя удалить категорию, которая используется в записях.");
        }

        draft.categories = draft.categories.filter((item) => item.id !== categoryId);
      });
    }

    updateSettings(input) {
      const draft = normalizeSettings({ ...this.settings, ...input });
      this.persist(SETTINGS_KEY, draft);
      this.settings = draft;
      return this.getSettings();
    }

    exportBackup() {
      return { schemaVersion: SCHEMA_VERSION, data: this.getData(), settings: this.getSettings() };
    }

    replaceBackup(backup) {
      const normalized = normalizeBackup(backup);
      const previousData = this.read(DATA_KEY);
      const previousSettings = this.read(SETTINGS_KEY);
      try {
        this.persist(DATA_KEY, normalized.data);
        this.persist(SETTINGS_KEY, normalized.settings);
      } catch (error) {
        try {
          if (previousData === null) this.storage.removeItem(DATA_KEY); else this.storage.setItem(DATA_KEY, previousData);
          if (previousSettings === null) this.storage.removeItem(SETTINGS_KEY); else this.storage.setItem(SETTINGS_KEY, previousSettings);
        } catch (rollbackError) {
          // Ошибка уже отражена в состоянии хранилища. В памяти данные не меняются.
        }
        throw error;
      }
      this.data = normalized.data;
      this.settings = normalized.settings;
      this.recovery = { data: null, settings: null };
      return this.exportBackup();
    }

    resetCorruptedData() {
      if (this.recovery.data === null) {
        return this.getData();
      }

      const freshData = createInitialData();
      this.persist(DATA_KEY, freshData);
      this.data = freshData;
      this.recovery.data = null;
      return this.getData();
    }

    resetCorruptedSettings() {
      if (this.recovery.settings === null) {
        return this.getSettings();
      }

      const freshSettings = createInitialSettings();
      this.persist(SETTINGS_KEY, freshSettings);
      this.settings = freshSettings;
      this.recovery.settings = null;
      return this.getSettings();
    }

    updateData(mutator) {
      if (this.recovery.data !== null) {
        throw new PlannerStorageError("Данные повреждены. Сначала требуется восстановление или сброс.");
      }

      const draft = deepCopy(this.data);
      mutator(draft);
      const normalizedData = normalizeData(draft);

      this.persist(DATA_KEY, normalizedData);
      this.data = normalizedData;
    }

    loadData() {
      const rawData = this.read(DATA_KEY);
      if (rawData === null) {
        const freshData = createInitialData();
        this.tryPersistInitialValue(DATA_KEY, freshData);
        return freshData;
      }

      try {
        return normalizeData(JSON.parse(rawData));
      } catch (error) {
        this.recovery.data = { rawData, reason: readableError(error) };
        return createInitialData();
      }
    }

    loadSettings() {
      const rawSettings = this.read(SETTINGS_KEY);
      if (rawSettings === null) {
        const freshSettings = createInitialSettings();
        this.tryPersistInitialValue(SETTINGS_KEY, freshSettings);
        return freshSettings;
      }

      try {
        return normalizeSettings(JSON.parse(rawSettings));
      } catch (error) {
        this.recovery.settings = { rawData: rawSettings, reason: readableError(error) };
        return createInitialSettings();
      }
    }

    read(key) {
      try {
        return this.storage.getItem(key);
      } catch (error) {
        this.lastSaveError = "Браузер не предоставил доступ к локальному хранилищу.";
        return null;
      }
    }

    persist(key, value) {
      let serializedValue;
      try {
        serializedValue = JSON.stringify(value);
      } catch (error) {
        throw new PlannerStorageError("Не удалось подготовить данные к сохранению.");
      }

      try {
        this.storage.setItem(key, serializedValue);
        this.lastSaveError = null;
      } catch (error) {
        this.lastSaveError = "Не удалось сохранить данные в браузере. Изменение не применено.";
        throw new PlannerStorageError(this.lastSaveError);
      }
    }

    tryPersistInitialValue(key, value) {
      try {
        this.persist(key, value);
      } catch (error) {
        // При недоступном localStorage приложение остаётся открытым, но не сообщает об успешном сохранении.
      }
    }
  }

  function createStore(storage = window.localStorage) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      throw new PlannerStorageError("Локальное хранилище недоступно.");
    }

    return new PlannerStore(storage);
  }

  function createInitialData() {
    const createdAt = nowIso();

    return {
      schemaVersion: SCHEMA_VERSION,
      records: [],
      categories: DEFAULT_CATEGORY_DEFINITIONS.map((category) => ({ ...category, isDefault: true, createdAt })),
    };
  }

  function createInitialSettings() {
    return {
      schemaVersion: SCHEMA_VERSION,
      view: "week",
      selectedDate: toDateKey(new Date()),
      filters: {
        categoryIds: [],
        status: "active",
        period: "current-week",
        dateFrom: null,
        dateTo: null,
        query: "",
      },
    };
  }

  function normalizeData(input) {
    if (!isPlainObject(input)) {
      throw new PlannerValidationError("Данные должны быть объектом.");
    }
    if (input.schemaVersion !== SCHEMA_VERSION) {
      throw new PlannerValidationError("Версия данных не поддерживается.");
    }
    if (!Array.isArray(input.categories) || !Array.isArray(input.records)) {
      throw new PlannerValidationError("В данных отсутствует список категорий или записей.");
    }

    const categories = input.categories.map((category, index, list) => normalizeCategory(category, list, index));
    DEFAULT_CATEGORY_DEFINITIONS.forEach((defaultCategory) => {
      const category = categories.find((item) => item.id === defaultCategory.id && item.isDefault);
      if (category) category.color = defaultCategory.color;
    });
    assertUniqueIds(categories, "категорий");
    assertDefaultCategories(categories);

    const records = input.records.map((record) => normalizeRecord(record, categories));
    assertUniqueIds(records, "записей");

    return { schemaVersion: SCHEMA_VERSION, categories, records };
  }

  function normalizeBackup(input) {
    if (!isPlainObject(input)) {
      throw new PlannerValidationError("Резервная копия должна быть объектом.");
    }
    if (input.schemaVersion !== SCHEMA_VERSION) {
      throw new PlannerValidationError("Версия резервной копии не поддерживается.");
    }
    if (!isPlainObject(input.data) || !isPlainObject(input.settings)) {
      throw new PlannerValidationError("В резервной копии отсутствуют данные или настройки.");
    }
    return { schemaVersion: SCHEMA_VERSION, data: normalizeData(input.data), settings: normalizeSettings(input.settings) };
  }

  function normalizeCategory(input, existingCategories = [], categoryIdToIgnore = null) {
    if (!isPlainObject(input)) {
      throw new PlannerValidationError("Категория должна быть объектом.");
    }

    const id = requireString(input.id, "Идентификатор категории");
    const name = requireTrimmedString(input.name, "Название категории", 1, 30);
    const color = requireString(input.color, "Цвет категории");
    const isDefault = input.isDefault === true;
    const createdAt = requireIsoDateTime(input.createdAt, "Дата создания категории");
    const normalizedName = name.toLocaleLowerCase("ru-RU");
    const nameExists = existingCategories.some((category) => {
      if (!category || category.id === categoryIdToIgnore || category.id === id) {
        return false;
      }
      return String(category.name || "").trim().toLocaleLowerCase("ru-RU") === normalizedName;
    });

    if (nameExists) {
      throw new PlannerValidationError("Название категории уже используется.");
    }
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      throw new PlannerValidationError("Выберите корректный цвет категории.");
    }

    return { id, name, color, isDefault, createdAt };
  }

  function normalizeRecord(input, categories) {
    if (!isPlainObject(input)) {
      throw new PlannerValidationError("Запись должна быть объектом.");
    }

    const id = requireString(input.id, "Идентификатор записи");
    const type = requireAllowedValue(input.type, RECORD_TYPES, "Тип записи");
    const title = requireTrimmedString(input.title, "Название", 1, MAX_TITLE_LENGTH);
    const categoryId = requireString(input.categoryId, "Категория");
    const status = requireAllowedValue(input.status, RECORD_STATUSES, "Статус");
    const createdAt = requireIsoDateTime(input.createdAt, "Дата создания");
    const updatedAt = requireIsoDateTime(input.updatedAt, "Дата изменения");
    const description = optionalTrimmedString(input.description, MAX_DESCRIPTION_LENGTH);
    const startDate = optionalDate(input.startDate, "Дата начала");
    const endDate = optionalDate(input.endDate, "Дата окончания");
    const time = optionalTime(input.time);
    const isCompleted = input.isCompleted === true;
    const completedAt = optionalIsoDateTime(input.completedAt, "Дата завершения");
    const deletedAt = optionalIsoDateTime(input.deletedAt, "Дата удаления");
    const statusBeforeTrash = optionalAllowedValue(input.statusBeforeTrash, new Set(["active", "archived"]), "Исходный статус");
    const repeat = normalizeRepeat(input.repeat, startDate);
    const seriesId = optionalString(input.seriesId, "Идентификатор серии");
    const originalOccurrenceDate = optionalDate(input.originalOccurrenceDate, "Исходная дата экземпляра");

    if (!categories.some((category) => category.id === categoryId)) {
      throw new PlannerValidationError("У записи указана несуществующая категория.");
    }
    if (endDate !== null && (type !== "event" || startDate === null || endDate < startDate)) {
      throw new PlannerValidationError("Дата окончания доступна только событию и не может быть раньше даты начала.");
    }
    if (startDate === null && (endDate !== null || time !== null || repeat !== null)) {
      throw new PlannerValidationError("Запись без даты не может иметь время, дату окончания или повторение.");
    }
    if (status === "trash" && (deletedAt === null || statusBeforeTrash === null)) {
      throw new PlannerValidationError("Для записи в корзине нужны дата удаления и исходный статус.");
    }
    if (status !== "trash" && statusBeforeTrash !== null) {
      throw new PlannerValidationError("Исходный статус указывается только для записи в корзине.");
    }
    if (status === "active" && (isCompleted || completedAt !== null)) {
      throw new PlannerValidationError("Активная запись не может быть завершённой.");
    }
    if (status === "archived" && (!isCompleted || completedAt === null)) {
      throw new PlannerValidationError("Архивная запись должна иметь отметку о завершении.");
    }
    if (status === "trash" && statusBeforeTrash === "archived" && (!isCompleted || completedAt === null)) {
      throw new PlannerValidationError("Удалённая архивная запись должна сохранять отметку о завершении.");
    }
    if (repeat !== null && seriesId === null) {
      throw new PlannerValidationError("Для повторяющейся записи нужен идентификатор серии.");
    }
    if (originalOccurrenceDate !== null && (seriesId === null || repeat !== null)) {
      throw new PlannerValidationError("Изменённый экземпляр должен быть отдельной записью серии без правила повторения.");
    }

    return {
      id,
      type,
      title,
      categoryId,
      status,
      createdAt,
      updatedAt,
      description,
      startDate,
      endDate,
      time,
      isCompleted,
      completedAt,
      deletedAt,
      statusBeforeTrash,
      repeat,
      seriesId,
      originalOccurrenceDate,
    };
  }

  function normalizeRepeat(input, startDate) {
    if (input === null || input === undefined) {
      return null;
    }
    if (!isPlainObject(input) || startDate === null) {
      throw new PlannerValidationError("Повторение доступно только записи с датой начала.");
    }

    const frequency = input.frequency;
    const endCondition = input.endCondition;
    const endValue = input.endValue;
    if (frequency !== "daily") {
      throw new PlannerValidationError("В первой версии доступно только ежедневное повторение.");
    }
    if (!REPEAT_END_CONDITIONS.has(endCondition)) {
      throw new PlannerValidationError("Укажите корректное условие окончания повторения.");
    }
    if (endCondition === "date") {
      const endDate = optionalDate(endValue, "Дата окончания серии");
      if (endDate === null || endDate < startDate) {
        throw new PlannerValidationError("Дата окончания серии не может быть раньше даты начала.");
      }
      return { frequency, endCondition, endValue: endDate };
    }
    if (endCondition === "count") {
      if (!Number.isInteger(endValue) || endValue < 1 || endValue > 365) {
        throw new PlannerValidationError("Количество повторений должно быть целым числом от 1 до 365.");
      }
      return { frequency, endCondition, endValue };
    }
    if (endValue !== null) {
      throw new PlannerValidationError("Для серии без окончания значение окончания должно быть пустым.");
    }
    return { frequency, endCondition, endValue: null };
  }

  function normalizeSettings(input) {
    if (!isPlainObject(input) || input.schemaVersion !== SCHEMA_VERSION) {
      throw new PlannerValidationError("Настройки имеют неподдерживаемую версию.");
    }

    const filters = isPlainObject(input.filters) ? input.filters : {};
    const categoryIds = Array.isArray(filters.categoryIds) ? filters.categoryIds.filter((id) => typeof id === "string") : [];
    const status = FILTER_STATUSES.has(filters.status) ? filters.status : "active";
    const period = typeof filters.period === "string" ? filters.period : "current-week";
    const dateFrom = optionalDate(filters.dateFrom, "Начало периода");
    const dateTo = optionalDate(filters.dateTo, "Конец периода");
    if (dateFrom !== null && dateTo !== null && dateTo < dateFrom) {
      throw new PlannerValidationError("Конец периода не может быть раньше начала.");
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      view: ["day", "week", "month"].includes(input.view) ? input.view : "week",
      selectedDate: optionalDate(input.selectedDate, "Выбранная дата") || toDateKey(new Date()),
      filters: {
        categoryIds: [...new Set(categoryIds)],
        status,
        period,
        dateFrom,
        dateTo,
        query: typeof filters.query === "string" ? filters.query.trim() : "",
      },
    };
  }

  function assertDefaultCategories(categories) {
    for (const defaultCategory of DEFAULT_CATEGORY_DEFINITIONS) {
      const category = categories.find((item) => item.id === defaultCategory.id);
      if (!category || !category.isDefault) {
        throw new PlannerValidationError("Стартовые категории отсутствуют или повреждены.");
      }
    }
  }

  function assertUniqueIds(items, itemName) {
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) {
        throw new PlannerValidationError(`Обнаружены повторяющиеся идентификаторы ${itemName}.`);
      }
      ids.add(item.id);
    }
  }

  function requireString(value, fieldName) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new PlannerValidationError(`${fieldName} обязательно.`);
    }
    return value.trim();
  }

  function optionalString(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    return requireString(value, fieldName);
  }

  function requireTrimmedString(value, fieldName, minLength, maxLength) {
    const result = requireString(value, fieldName);
    if (result.length < minLength || result.length > maxLength) {
      throw new PlannerValidationError(`${fieldName} должно содержать от ${minLength} до ${maxLength} символов.`);
    }
    return result;
  }

  function optionalTrimmedString(value, maxLength) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const result = String(value).trim();
    if (result.length > maxLength) {
      throw new PlannerValidationError(`Описание не может быть длиннее ${maxLength} символов.`);
    }
    return result || null;
  }

  function requireAllowedValue(value, allowedValues, fieldName) {
    if (!allowedValues.has(value)) {
      throw new PlannerValidationError(`${fieldName} имеет недопустимое значение.`);
    }
    return value;
  }

  function optionalAllowedValue(value, allowedValues, fieldName) {
    if (value === null || value === undefined) {
      return null;
    }
    return requireAllowedValue(value, allowedValues, fieldName);
  }

  function optionalDate(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new PlannerValidationError(`${fieldName} должна быть в формате ГГГГ-ММ-ДД.`);
    }
    const [year, month, day] = value.split("-").map(Number);
    const localDate = new Date(year, month - 1, day);
    if (localDate.getFullYear() !== year || localDate.getMonth() !== month - 1 || localDate.getDate() !== day) {
      throw new PlannerValidationError(`${fieldName} содержит несуществующую дату.`);
    }
    return value;
  }

  function optionalTime(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new PlannerValidationError("Время должно быть в формате ЧЧ:ММ.");
    }
    return value;
  }

  function requireIsoDateTime(value, fieldName) {
    const result = optionalIsoDateTime(value, fieldName);
    if (result === null) {
      throw new PlannerValidationError(`${fieldName} обязательна.`);
    }
    return result;
  }

  function optionalIsoDateTime(value, fieldName) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new PlannerValidationError(`${fieldName} должна быть ISO-датой и временем.`);
    }
    return value;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function createId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function toDateKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function deepCopy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readableError(error) {
    return error instanceof Error ? error.message : "Неизвестная ошибка данных.";
  }

  function getMonday(date) {
    const localDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const weekdayIndex = (localDate.getDay() + 6) % 7;

    localDate.setDate(localDate.getDate() - weekdayIndex);
    return localDate;
  }

  function renderInterface() {
    const weekGrid = document.querySelector("#week-grid");
    const periodLabel = document.querySelector("#period-label");
    if (!weekGrid || !periodLabel) return;
    const state = plannerStore.getData();
    const today = new Date();
    const weekStart = getMonday(today);
    const weekDates = Array.from({ length: 7 }, (_, index) => { const date = new Date(weekStart); date.setDate(date.getDate() + index); return date; });
    const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "long" });
    const weekdayFormatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
    weekGrid.replaceChildren(...weekDates.map((date) => createDayColumn(date, today, state, weekdayFormatter)));
    periodLabel.textContent = formatWeekRange(weekStart, monthFormatter);
    document.querySelector(".empty-week-message").hidden = state.records.some((record) => record.status === "active" && record.startDate !== null);
    renderInbox(state);
    renderStorageNotice();
  }

  function createDayColumn(date, today, state, weekdayFormatter) {
    const key = toDateKey(date);
    const day = document.createElement("article");
    day.className = `week-day${isSameDate(date, today) ? " is-today" : ""}`;
    const header = document.createElement("header"); header.className = "day-header";
    const name = document.createElement("p"); name.className = "day-name"; name.textContent = weekdayFormatter.format(date).replace(".", "");
    const number = document.createElement("time"); number.className = "day-number"; number.dateTime = key; number.textContent = date.getDate();
    header.append(name, number); day.append(header);
    const records = state.records.filter((record) => record.status === "active" && record.startDate === key).sort(compareRecords);
    if (records.length === 0) { const empty = document.createElement("p"); empty.className = "day-empty"; empty.textContent = "Нет записей"; day.append(empty); }
    records.forEach((record) => day.append(createRecordCard(record, state.categories)));
    return day;
  }

  function compareRecords(first, second) { return (first.time || "99:99").localeCompare(second.time || "99:99") || first.createdAt.localeCompare(second.createdAt); }

  function createRecordCard(record, categories) {
    const category = categories.find((item) => item.id === record.categoryId);
    const button = document.createElement("button"); button.type = "button"; button.className = "record-card"; button.style.setProperty("--category-color", category.color);
    const type = document.createElement("span"); type.className = "card-type"; type.textContent = record.type === "event" ? "Календарь" : "Задача";
    const text = document.createElement("span"); const title = document.createElement("strong"); title.textContent = record.title; text.append(title);
    if (record.time) { const time = document.createElement("small"); time.textContent = record.time; text.append(time); }
    button.append(type, text); button.addEventListener("click", () => openDetails(record.id)); return button;
  }

  function renderInbox(state = plannerStore.getData()) {
    const list = document.querySelector("#inbox-list"); if (!list) return;
    const records = state.records.filter((record) => record.status === "active" && record.startDate === null).sort(compareRecords);
    list.replaceChildren();
    if (!records.length) { const empty = document.createElement("p"); empty.textContent = "Во входящих пока нет записей."; list.append(empty); return; }
    records.forEach((record) => list.append(createRecordCard(record, state.categories)));
  }

  function openRecordForm(recordId = null, seed = {}) {
    const dialog = document.querySelector("#record-dialog"); const form = document.querySelector("#record-form"); const data = plannerStore.getData();
    const record = recordId ? data.records.find((item) => item.id === recordId) : null;
    form.reset(); form.elements.recordId.value = recordId || ""; form.elements.title.value = record?.title || seed.title || "";
    form.elements.type.value = record?.type || seed.type || "task"; form.elements.categoryId.replaceChildren(...data.categories.map((category) => new Option(category.name, category.id)));
    form.elements.categoryId.value = record?.categoryId || seed.categoryId || "personal"; form.elements.startDate.value = record?.startDate || seed.startDate || "";
    form.elements.endDate.value = record?.endDate || ""; form.elements.time.value = record?.time || ""; form.elements.description.value = record?.description || "";
    document.querySelector("#record-dialog-title").textContent = record ? "Редактировать запись" : "Новая запись"; document.querySelector("#record-form-error").textContent = ""; dialog.showModal(); form.elements.title.focus();
  }

  function saveRecord(event) {
    event.preventDefault(); const form = event.currentTarget; const error = document.querySelector("#record-form-error");
    const input = { type: form.elements.type.value, title: form.elements.title.value, categoryId: form.elements.categoryId.value, status: "active", description: form.elements.description.value, startDate: form.elements.startDate.value || null, endDate: form.elements.endDate.value || null, time: form.elements.time.value || null, isCompleted: false, completedAt: null, deletedAt: null, statusBeforeTrash: null, repeat: null, seriesId: null, originalOccurrenceDate: null };
    if (input.startDate === null) { input.time = null; input.endDate = null; }
    try { if (form.elements.recordId.value) plannerStore.replaceRecord(form.elements.recordId.value, input); else plannerStore.createRecord(input); form.closest("dialog").close(); renderInterface(); } catch (caught) { error.textContent = readableError(caught); }
  }

  function openDetails(recordId) {
    const record = plannerStore.getData().records.find((item) => item.id === recordId); if (!record) return;
    const dialog = document.querySelector("#details-dialog"); const content = document.querySelector("#details-content"); content.replaceChildren();
    const headingRow = document.createElement("div"); headingRow.className = "dialog-heading"; const heading = document.createElement("h2"); heading.textContent = record.title; const closeTop = document.createElement("button"); closeTop.className = "close-dialog"; closeTop.type = "button"; closeTop.setAttribute("aria-label", "Закрыть окно"); closeTop.title = "Закрыть"; closeTop.textContent = "×"; closeTop.addEventListener("click", () => dialog.close()); headingRow.append(heading, closeTop); const info = document.createElement("p"); info.textContent = `${record.type === "event" ? "Событие" : "Задача"}${record.startDate ? `, ${record.startDate}${record.time ? ` в ${record.time}` : ""}` : ", Входящие"}`;
    const description = document.createElement("p"); description.textContent = record.description || "Без описания"; const actions = document.createElement("div"); actions.className = "dialog-actions";
    const edit = document.createElement("button"); edit.className = "today-button"; edit.type = "button"; edit.textContent = "Редактировать"; edit.addEventListener("click", () => { dialog.close(); openRecordForm(record.id); });
    const duplicate = document.createElement("button"); duplicate.className = "today-button"; duplicate.type = "button"; duplicate.textContent = "Дублировать"; duplicate.addEventListener("click", () => { dialog.close(); openRecordForm(null, { ...record, title: `${record.title} (копия)` }); });
    actions.append(edit, duplicate); content.append(headingRow, info, description, actions); dialog.showModal();
  }

  function openCategories() { renderCategories(); document.querySelector("#categories-dialog").showModal(); }
  function renderCategories() {
    const list = document.querySelector("#categories-list"); const data = plannerStore.getData(); list.replaceChildren();
    data.categories.forEach((category) => { const item = document.createElement("div"); item.className = "category-item"; item.style.setProperty("--category-color", category.color); const name = document.createElement("span"); const dot = document.createElement("i"); dot.className = "category-dot"; name.append(dot, document.createTextNode(category.name)); item.append(name); if (!category.isDefault) { const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Переименовать"; edit.addEventListener("click", () => { const input = document.createElement("input"); const save = document.createElement("button"); input.value = category.name; input.setAttribute("aria-label", "Новое название категории"); save.type = "button"; save.textContent = "Сохранить"; save.addEventListener("click", () => { try { plannerStore.updateCategory(category.id, { name: input.value, color: category.color }); renderCategories(); renderInterface(); } catch (caught) { document.querySelector("#category-form-error").textContent = readableError(caught); } }); edit.replaceWith(input, save); input.focus(); }); const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Удалить"; remove.addEventListener("click", () => { try { plannerStore.deleteCategory(category.id); renderCategories(); renderInterface(); } catch (caught) { document.querySelector("#category-form-error").textContent = readableError(caught); } }); item.append(edit, remove); } list.append(item); });
  }

  function bindInterface() {
    document.querySelector("#create-record")?.addEventListener("click", () => openRecordForm());
    document.querySelector("#open-inbox")?.addEventListener("click", () => { const panel = document.querySelector("#inbox-panel"); panel.hidden = !panel.hidden; if (!panel.hidden) panel.querySelector("button").focus(); });
    document.querySelector("#open-categories")?.addEventListener("click", openCategories);
    document.querySelector("#record-form")?.addEventListener("submit", saveRecord);
    document.querySelector("#clear-record-date")?.addEventListener("click", () => { const form = document.querySelector("#record-form"); form.elements.startDate.value = ""; form.elements.endDate.value = ""; form.elements.time.value = ""; });
    document.querySelector("#category-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = event.currentTarget; try { plannerStore.createCategory({ name: form.elements.name.value, color: form.elements.color.value }); form.reset(); document.querySelector("#category-form-error").textContent = ""; renderCategories(); renderInterface(); } catch (caught) { document.querySelector("#category-form-error").textContent = readableError(caught); } });
    document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { const target = document.querySelector(`#${button.dataset.close}`); if (target?.close) target.close(); else target.hidden = true; }));
    document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));
  }

  function renderStorageNotice() {
    const notice = document.querySelector("#storage-notice");
    if (!notice) {
      return;
    }

    const recoveryState = plannerStore.getRecoveryState();
    notice.replaceChildren();
    notice.hidden = true;

    if (recoveryState.data) {
      const message = document.createElement("p");
      const resetButton = document.createElement("button");
      message.textContent = "Не удалось прочитать сохранённые данные. Они не были перезаписаны.";
      resetButton.type = "button";
      resetButton.textContent = "Сбросить повреждённые данные";
      resetButton.addEventListener("click", () => {
        try {
          plannerStore.resetCorruptedData();
          renderStorageNotice();
        } catch (error) {
          showStorageError(notice);
        }
      });
      notice.append(message, resetButton);
      notice.hidden = false;
      return;
    }

    if (recoveryState.settings || recoveryState.saveError) {
      const message = document.createElement("p");
      message.textContent = recoveryState.settings
        ? "Не удалось прочитать настройки интерфейса. Их можно безопасно сбросить."
        : recoveryState.saveError;
      notice.append(message);
      if (recoveryState.settings) {
        const resetButton = document.createElement("button");
        resetButton.type = "button";
        resetButton.textContent = "Сбросить настройки";
        resetButton.addEventListener("click", () => {
          try {
            plannerStore.resetCorruptedSettings();
            renderStorageNotice();
          } catch (error) {
            showStorageError(notice);
          }
        });
        notice.append(resetButton);
      }
      notice.hidden = false;
    }
  }

  function showStorageError(notice) {
    notice.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "Не удалось сохранить изменения в браузере. Данные не изменены.";
    notice.append(message);
    notice.hidden = false;
  }

  function formatWeekRange(startDate, monthFormatter) {
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    const startMonth = monthFormatter.format(startDate);
    const endMonth = monthFormatter.format(endDate);

    if (startDate.getMonth() === endDate.getMonth()) {
      return `${startDate.getDate()}-${endDate.getDate()} ${startMonth} ${startDate.getFullYear()}`;
    }

    const endYear = startDate.getFullYear() === endDate.getFullYear() ? "" : ` ${endDate.getFullYear()}`;
    return `${startDate.getDate()} ${startMonth} - ${endDate.getDate()} ${endMonth}${endYear}`;
  }

  function isSameDate(firstDate, secondDate) {
    return firstDate.getFullYear() === secondDate.getFullYear()
      && firstDate.getMonth() === secondDate.getMonth()
      && firstDate.getDate() === secondDate.getDate();
  }

  let draggedRecordId = null;

  function renderInterface() {
    const grid = document.querySelector("#week-grid");
    const settings = plannerStore.getSettings();
    const data = plannerStore.getData();
    if (!grid) return;
    syncControls(settings, data.categories);
    document.querySelector("#calendar-title").textContent = settings.view === "day" ? "День" : settings.view === "month" ? "Месяц" : "Неделя";
    const selected = dateFromKey(settings.selectedDate);
    document.querySelector("#period-label").textContent = formatPeriod(selected, settings.view);
    grid.className = settings.view === "month" ? "month-grid" : settings.view === "day" ? "day-view" : "week-grid";
    grid.replaceChildren();
    if (settings.view === "month") renderMonth(grid, selected, data, settings);
    else if (settings.view === "day") renderDay(grid, selected, data, settings);
    else renderWeek(grid, selected, data, settings);
    renderInbox(data, settings);
    renderStorageNotice();
  }

  function syncControls(settings, categories) {
    document.querySelectorAll("[data-view]").forEach((button) => { const active = button.dataset.view === settings.view; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    const category = document.querySelector("#filter-category"); category.replaceChildren(new Option("Все категории", ""), ...categories.map((item) => new Option(item.name, item.id))); category.value = settings.filters.categoryIds[0] || "";
    document.querySelector("#filter-status").value = settings.filters.status;
    document.querySelector("#filter-period").value = settings.filters.period;
    document.querySelector("#global-search").value = settings.filters.query;
  }

  function renderWeek(grid, selected, data, settings) {
    const start = getMonday(selected); const formatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
    for (let index = 0; index < 7; index += 1) { const date = addDays(start, index); const key = toDateKey(date); const column = document.createElement("article"); column.className = `week-day${isSameDate(date, new Date()) ? " is-today" : ""}`; column.dataset.date = key;
      const header = document.createElement("header"); header.className = "day-header"; const name = document.createElement("p"); name.className = "day-name"; name.textContent = formatter.format(date).replace(".", ""); const number = document.createElement("time"); number.className = "day-number"; number.dateTime = key; number.textContent = date.getDate(); header.append(name, number); column.append(header);
      const records = filterRecords(data.records, data.categories, settings).filter((record) => occursOn(record, key)).sort(compareRecords);
      if (!records.length) { const empty = document.createElement("p"); empty.className = "day-empty"; empty.textContent = "Нет записей"; column.append(empty); }
      records.forEach((record) => column.append(createRecordCard(record, data.categories)));
      bindDropTarget(column);
      column.addEventListener("click", (event) => {
        if (!event.target.closest(".record-card") && !draggedRecordId) setCalendarState({ view: "day", selectedDate: key });
      });
      grid.append(column); }
  }

  function renderDay(grid, selected, data, settings) {
    const key = toDateKey(selected); const heading = document.createElement("h3"); heading.textContent = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(selected); grid.append(heading);
    const records = filterRecords(data.records, data.categories, settings).filter((record) => occursOn(record, key)).sort(compareRecords);
    if (!records.length) { const empty = document.createElement("p"); empty.className = "day-empty"; empty.textContent = "Нет записей"; grid.append(empty); } else records.forEach((record) => grid.append(createRecordCard(record, data.categories)));
  }

  function renderMonth(grid, selected, data, settings) {
    const first = new Date(selected.getFullYear(), selected.getMonth(), 1); const start = getMonday(first); const filtered = filterRecords(data.records, data.categories, settings);
    for (let index = 0; index < 42; index += 1) { const date = addDays(start, index); const key = toDateKey(date); const records = filtered.filter((record) => occursOn(record, key)); const cell = document.createElement("button"); cell.type = "button"; cell.className = `month-day${date.getMonth() !== selected.getMonth() ? " is-outside" : ""}${isSameDate(date, new Date()) ? " is-today" : ""}`; const number = document.createElement("time"); number.dateTime = key; number.textContent = date.getDate(); cell.append(number); if (records.length) { const count = document.createElement("span"); count.className = "month-count"; count.textContent = `${records.length} ${pluralizeRecords(records.length)}`; const colors = document.createElement("span"); colors.className = "category-indicators"; [...new Set(records.map((record) => record.categoryId))].forEach((id) => { const dot = document.createElement("i"); dot.style.setProperty("--category-color", data.categories.find((item) => item.id === id).color); colors.append(dot); }); cell.append(count, colors); } cell.addEventListener("click", () => setCalendarState({ view: "day", selectedDate: key })); grid.append(cell); }
  }

  function filterRecords(records, categories, settings) {
    const query = settings.filters.query.toLocaleLowerCase("ru-RU").trim(); const allowed = settings.filters.categoryIds;
    const selected = dateFromKey(settings.selectedDate); const rangeStart = settings.filters.period === "current-month" ? new Date(selected.getFullYear(), selected.getMonth(), 1) : settings.filters.period === "current-week" ? getMonday(selected) : null; const rangeEnd = rangeStart ? (settings.filters.period === "current-month" ? new Date(selected.getFullYear(), selected.getMonth() + 1, 0) : addDays(rangeStart, 6)) : null;
    return records.filter((record) => { if (record.status !== settings.filters.status) return false; if (allowed.length && !allowed.includes(record.categoryId)) return false; if (rangeStart && (!record.startDate || record.startDate > toDateKey(rangeEnd) || (record.endDate || record.startDate) < toDateKey(rangeStart))) return false; if (!query) return true; const category = categories.find((item) => item.id === record.categoryId); const type = record.type === "task" ? "задача" : "событие"; return [record.title, record.description || "", category?.name || "", type].join(" ").toLocaleLowerCase("ru-RU").includes(query); });
  }

  function occursOn(record, key) {
    if (record.startDate === null) return false;
    if (record.type === "event" && record.endDate !== null) return record.startDate <= key && record.endDate >= key;
    return record.startDate === key;
  }
  function hexToRgba(hex, opacity) { const value = hex.slice(1); const red = Number.parseInt(value.slice(0, 2), 16); const green = Number.parseInt(value.slice(2, 4), 16); const blue = Number.parseInt(value.slice(4, 6), 16); return `rgb(${red} ${green} ${blue} / ${opacity})`; }
  function createRecordCard(record, categories) { const category = categories.find((item) => item.id === record.categoryId); const button = document.createElement("button"); button.type = "button"; button.draggable = true; button.dataset.recordId = record.id; button.className = "record-card"; button.style.setProperty("--category-color", category.color); button.style.backgroundColor = hexToRgba(category.color, .2); const type = document.createElement("span"); type.className = "card-type"; type.textContent = record.type === "event" ? "Календарь" : "Задача"; const text = document.createElement("span"); const title = document.createElement("strong"); title.textContent = record.title; text.append(title); if (record.time) { const time = document.createElement("small"); time.textContent = record.time; text.append(time); } button.append(type, text); button.addEventListener("click", () => openDetails(record.id)); button.addEventListener("dragstart", (event) => { draggedRecordId = record.id; event.dataTransfer.effectAllowed = "move"; }); button.addEventListener("dragend", () => { draggedRecordId = null; }); return button; }
  function bindDropTarget(column) { column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("is-drop-target"); }); column.addEventListener("dragleave", () => column.classList.remove("is-drop-target")); column.addEventListener("drop", (event) => { event.preventDefault(); column.classList.remove("is-drop-target"); moveRecordToDate(draggedRecordId, column.dataset.date); }); }
  function moveRecordToDate(id, date) { const record = plannerStore.getData().records.find((item) => item.id === id); if (!record || !record.startDate || record.startDate === date) return; const delta = Math.round((dateFromKey(date) - dateFromKey(record.startDate)) / 86400000); const input = { ...record, startDate: date, endDate: record.endDate ? toDateKey(addDays(dateFromKey(record.endDate), delta)) : null }; plannerStore.replaceRecord(id, input); renderInterface(); }
  function renderInbox(data = plannerStore.getData(), settings = plannerStore.getSettings()) { const list = document.querySelector("#inbox-list"); if (!list) return; list.replaceChildren(); const records = filterRecords(data.records, data.categories, settings).filter((record) => record.startDate === null).sort(compareRecords); if (!records.length) { const empty = document.createElement("p"); empty.textContent = "Во входящих пока нет записей."; list.append(empty); } else records.forEach((record) => list.append(createRecordCard(record, data.categories))); }
  function setCalendarState(change) { const current = plannerStore.getSettings(); plannerStore.updateSettings({ ...current, ...change, filters: { ...current.filters, ...(change.filters || {}) } }); renderInterface(); }
  function addDays(date, days) { const result = new Date(date.getFullYear(), date.getMonth(), date.getDate()); result.setDate(result.getDate() + days); return result; }
  function dateFromKey(key) { const [year, month, day] = key.split("-").map(Number); return new Date(year, month - 1, day); }
  function formatPeriod(date, view) { if (view === "day") return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date); if (view === "month") return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(date); return formatWeekRange(getMonday(date), new Intl.DateTimeFormat("ru-RU", { month: "long" })); }
  function pluralizeRecords(count) { return count === 1 ? "запись" : count >= 2 && count <= 4 ? "записи" : "записей"; }

  function bindInterface() {
    document.querySelector("#create-record")?.addEventListener("click", () => openRecordForm()); document.querySelector("#open-inbox")?.addEventListener("click", () => { const panel = document.querySelector("#inbox-panel"); panel.hidden = !panel.hidden; }); document.querySelector("#open-categories")?.addEventListener("click", openCategories); document.querySelector("#record-form")?.addEventListener("submit", saveRecord); document.querySelector("#clear-record-date")?.addEventListener("click", () => { const form = document.querySelector("#record-form"); form.elements.startDate.value = ""; form.elements.endDate.value = ""; form.elements.time.value = ""; }); document.querySelector("#category-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = event.currentTarget; try { plannerStore.createCategory({ name: form.elements.name.value, color: form.elements.color.value }); form.reset(); document.querySelector("#category-form-error").textContent = ""; renderCategories(); renderInterface(); } catch (caught) { document.querySelector("#category-form-error").textContent = readableError(caught); } }); document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { const target = document.querySelector(`#${button.dataset.close}`); if (target?.close) target.close(); else target.hidden = true; })); document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("mousedown", (event) => { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }));
    document.addEventListener("click", (event) => { const filters = document.querySelector(".filters-panel"); if (filters?.open && !filters.contains(event.target)) filters.open = false; });
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setCalendarState({ view: button.dataset.view })));
    document.querySelector("#previous-period")?.addEventListener("click", () => navigatePeriod(-1)); document.querySelector("#next-period")?.addEventListener("click", () => navigatePeriod(1)); document.querySelector("#today-period")?.addEventListener("click", () => setCalendarState({ selectedDate: toDateKey(new Date()) }));
    document.querySelector("#global-search")?.addEventListener("input", (event) => updateFilters({ query: event.target.value })); document.querySelector("#filter-category")?.addEventListener("change", (event) => updateFilters({ categoryIds: event.target.value ? [event.target.value] : [] })); document.querySelector("#filter-status")?.addEventListener("change", (event) => updateFilters({ status: event.target.value })); document.querySelector("#filter-period")?.addEventListener("change", (event) => updateFilters({ period: event.target.value })); document.querySelector("#reset-filters")?.addEventListener("click", () => updateFilters({ categoryIds: [], status: "active", period: "open", dateFrom: null, dateTo: null, query: "" }));
  }
  function navigatePeriod(direction) { const settings = plannerStore.getSettings(); const date = dateFromKey(settings.selectedDate); if (settings.view === "day") date.setDate(date.getDate() + direction); else if (settings.view === "week") date.setDate(date.getDate() + direction * 7); else date.setMonth(date.getMonth() + direction); setCalendarState({ selectedDate: toDateKey(date) }); }
  function updateFilters(change) { const settings = plannerStore.getSettings(); setCalendarState({ filters: { ...settings.filters, ...change } }); }

  function dateDifference(firstKey, secondKey) { return Math.round((dateFromKey(secondKey) - dateFromKey(firstKey)) / 86400000); }
  function shiftDateKey(key, days) { return toDateKey(addDays(dateFromKey(key), days)); }
  function isRepeatStart(record, key) {
    if (!record.repeat || !record.startDate || key < record.startDate) return false;
    const index = dateDifference(record.startDate, key);
    if (record.repeat.endCondition === "date" && key > record.repeat.endValue) return false;
    if (record.repeat.endCondition === "count" && index >= record.repeat.endValue) return false;
    return true;
  }
  function occurrenceEnd(record, startDate) { return record.type === "event" && record.endDate ? shiftDateKey(startDate, dateDifference(record.startDate, record.endDate)) : null; }
  function recordMatchesFilters(record, categories, settings) {
    if (record.status !== settings.filters.status) return false;
    if (settings.filters.categoryIds.length && !settings.filters.categoryIds.includes(record.categoryId)) return false;
    const query = settings.filters.query.trim().toLocaleLowerCase("ru-RU");
    if (!query) return true;
    const category = categories.find((item) => item.id === record.categoryId);
    const type = record.type === "task" ? "задача" : "событие";
    return [record.title, record.description || "", category?.name || "", type].join(" ").toLocaleLowerCase("ru-RU").includes(query);
  }
  function hasSeriesException(records, seriesId, occurrenceDate) { return records.some((record) => record.seriesId === seriesId && record.originalOccurrenceDate === occurrenceDate); }
  function recordsForDate(data, settings, key) {
    const visible = [];
    data.records.filter((record) => recordMatchesFilters(record, data.categories, settings)).forEach((record) => {
      if (!record.repeat) {
        if (occursOn(record, key)) visible.push(record);
        return;
      }
      const duration = record.type === "event" && record.endDate ? dateDifference(record.startDate, record.endDate) : 0;
      for (let offset = 0; offset <= duration; offset += 1) {
        const occurrenceDate = shiftDateKey(key, -offset);
        if (!isRepeatStart(record, occurrenceDate) || hasSeriesException(data.records, record.seriesId, occurrenceDate)) continue;
        visible.push({ ...record, startDate: occurrenceDate, endDate: occurrenceEnd(record, occurrenceDate), occurrenceDate, isVirtualOccurrence: true, parentId: record.id });
      }
    });
    return visible.sort(compareRecords);
  }
  function renderWeek(grid, selected, data, settings) {
    const start = getMonday(selected); const formatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
    for (let index = 0; index < 7; index += 1) {
      const date = addDays(start, index); const key = toDateKey(date); const column = document.createElement("article"); column.className = `week-day${isSameDate(date, new Date()) ? " is-today" : ""}`; column.dataset.date = key;
      const header = document.createElement("header"); header.className = "day-header"; const name = document.createElement("p"); name.className = "day-name"; name.textContent = formatter.format(date).replace(".", ""); const number = document.createElement("time"); number.className = "day-number"; number.dateTime = key; number.textContent = date.getDate(); header.append(name, number); column.append(header);
      const records = recordsForDate(data, settings, key); if (!records.length) { const empty = document.createElement("p"); empty.className = "day-empty"; empty.textContent = "Нет записей"; column.append(empty); }
      records.forEach((record) => column.append(createRecordCard(record, data.categories))); bindDropTarget(column); column.addEventListener("click", (event) => { if (!event.target.closest(".record-card") && !draggedRecordId) setCalendarState({ view: "day", selectedDate: key }); }); grid.append(column);
    }
  }
  function renderDay(grid, selected, data, settings) { const key = toDateKey(selected); const heading = document.createElement("h3"); heading.textContent = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(selected); grid.append(heading); const records = recordsForDate(data, settings, key); if (!records.length) { const empty = document.createElement("p"); empty.className = "day-empty"; empty.textContent = "Нет записей"; grid.append(empty); } else records.forEach((record) => grid.append(createRecordCard(record, data.categories))); }
  function renderMonth(grid, selected, data, settings) {
    const first = new Date(selected.getFullYear(), selected.getMonth(), 1); const start = getMonday(first);
    for (let index = 0; index < 42; index += 1) { const date = addDays(start, index); const key = toDateKey(date); const records = recordsForDate(data, settings, key); const cell = document.createElement("button"); cell.type = "button"; cell.className = `month-day${date.getMonth() !== selected.getMonth() ? " is-outside" : ""}${isSameDate(date, new Date()) ? " is-today" : ""}`; const number = document.createElement("time"); number.dateTime = key; number.textContent = date.getDate(); cell.append(number); if (records.length) { const count = document.createElement("span"); count.className = "month-count"; count.textContent = `${records.length} ${pluralizeRecords(records.length)}`; const colors = document.createElement("span"); colors.className = "category-indicators"; [...new Set(records.map((record) => record.categoryId))].forEach((id) => { const dot = document.createElement("i"); dot.style.setProperty("--category-color", data.categories.find((item) => item.id === id).color); colors.append(dot); }); cell.append(count, colors); } cell.addEventListener("click", () => setCalendarState({ view: "day", selectedDate: key })); grid.append(cell); }
  }
  function filterRecords(records, categories, settings) { return records.filter((record) => recordMatchesFilters(record, categories, settings)); }
  function createRecordCard(record, categories) {
    const category = categories.find((item) => item.id === record.categoryId); const button = document.createElement("button"); button.type = "button"; button.draggable = record.status === "active"; button.dataset.recordId = record.id; button.className = `record-card${record.status === "archived" ? " is-archived" : ""}`; button.style.setProperty("--category-color", category.color); button.style.backgroundColor = record.status === "archived" ? "" : hexToRgba(category.color, .2);
    const type = document.createElement("span"); type.className = "card-type"; type.textContent = record.status === "archived" ? `Архив - ${category.name}` : record.type === "event" ? "Календарь" : "Задача"; const text = document.createElement("span"); const title = document.createElement("strong"); title.textContent = record.title; text.append(title); if (record.time) { const time = document.createElement("small"); time.textContent = record.time; text.append(time); } button.append(type, text);
    button.addEventListener("click", () => openDetails(record)); button.addEventListener("dragstart", (event) => { draggedRecordId = record; event.dataTransfer.effectAllowed = "move"; }); button.addEventListener("dragend", () => { draggedRecordId = null; }); return button;
  }
  function bindDropTarget(column) { column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("is-drop-target"); }); column.addEventListener("dragleave", () => column.classList.remove("is-drop-target")); column.addEventListener("drop", async (event) => { event.preventDefault(); column.classList.remove("is-drop-target"); await moveRecordToDate(draggedRecordId, column.dataset.date); }); }
  async function moveRecordToDate(record, date) {
    if (!record || !record.startDate || record.startDate === date) return;
    if (record.isVirtualOccurrence) { const scope = await chooseSeriesScope("Перенос повторения", "Как перенести повторяющийся экземпляр?"); if (!scope) return; const input = { ...record, startDate: date, endDate: record.endDate ? shiftDateKey(record.endDate, dateDifference(record.startDate, date)) : null }; applySeriesEdit(record, input, scope); }
    else { const delta = dateDifference(record.startDate, date); plannerStore.replaceRecord(record.id, { ...record, startDate: date, endDate: record.endDate ? shiftDateKey(record.endDate, delta) : null }); }
    renderInterface();
  }
  function baseRecord(record) { return plannerStore.getData().records.find((item) => item.id === (record.parentId || record.id)); }
  function buildRepeatFromForm(form) {
    if (!form.elements.repeatEnabled.checked) return null;
    const endCondition = form.elements.repeatEndCondition.value;
    const endValue = endCondition === "date" ? form.elements.repeatEndValue.value : endCondition === "count" ? Number(form.elements.repeatEndValue.value) : null;
    return { frequency: "daily", endCondition, endValue };
  }
  function buildFormRecord(form, existing = null) {
    const repeat = buildRepeatFromForm(form);
    const startDate = form.elements.startDate.value || null;
    return { type: form.elements.type.value, title: form.elements.title.value, categoryId: form.elements.categoryId.value, status: existing?.status || "active", description: form.elements.description.value, startDate, endDate: form.elements.endDate.value || null, time: form.elements.time.value || null, isCompleted: existing?.isCompleted || false, completedAt: existing?.completedAt || null, deletedAt: existing?.deletedAt || null, statusBeforeTrash: existing?.statusBeforeTrash || null, repeat, seriesId: repeat ? (existing?.seriesId || createId("series")) : null, originalOccurrenceDate: null };
  }
  function syncRepeatControls(form) {
    const settings = document.querySelector("#repeat-settings"); const valueLabel = document.querySelector("#repeat-end-value-label"); const enabled = form.elements.repeatEnabled.checked; const condition = form.elements.repeatEndCondition.value; settings.hidden = !enabled; valueLabel.hidden = !enabled || condition === "never";
    if (condition === "count") { valueLabel.firstChild.textContent = "Количество повторений"; form.elements.repeatEndValue.type = "number"; form.elements.repeatEndValue.min = "1"; form.elements.repeatEndValue.max = "365"; if (!form.elements.repeatEndValue.value) form.elements.repeatEndValue.value = "1"; }
    else { valueLabel.firstChild.textContent = "Дата окончания"; form.elements.repeatEndValue.type = "date"; form.elements.repeatEndValue.removeAttribute("min"); form.elements.repeatEndValue.removeAttribute("max"); }
  }
  function openRecordForm(recordOrId = null, seed = {}) {
    const dialog = document.querySelector("#record-dialog"); const form = document.querySelector("#record-form"); const data = plannerStore.getData(); const visualRecord = typeof recordOrId === "object" ? recordOrId : null; const record = typeof recordOrId === "string" ? data.records.find((item) => item.id === recordOrId) : visualRecord || null; const parent = visualRecord?.isVirtualOccurrence ? baseRecord(visualRecord) : null;
    form.reset(); form.elements.recordId.value = parent?.id || record?.id || ""; form.elements.occurrenceDate.value = visualRecord?.occurrenceDate || ""; form.elements.title.value = record?.title || seed.title || ""; form.elements.type.value = record?.type || seed.type || "task"; form.elements.categoryId.replaceChildren(...data.categories.map((category) => new Option(category.name, category.id))); form.elements.categoryId.value = record?.categoryId || seed.categoryId || "personal"; form.elements.startDate.value = record?.startDate || seed.startDate || ""; form.elements.endDate.value = record?.endDate || seed.endDate || ""; form.elements.time.value = record?.time || seed.time || ""; form.elements.description.value = record?.description || seed.description || "";
    const rawRepeat = parent?.repeat || record?.repeat || null; form.elements.repeatEnabled.checked = rawRepeat !== null; form.elements.repeatEndCondition.value = rawRepeat?.endCondition || "date"; form.elements.repeatEndValue.value = rawRepeat?.endValue || ""; const repeatChoice = form.querySelector(".repeat-choice"); repeatChoice.hidden = Boolean(visualRecord?.isVirtualOccurrence); document.querySelector("#repeat-settings").hidden = Boolean(visualRecord?.isVirtualOccurrence); const scope = document.querySelector("#series-edit-scope"); scope.hidden = !visualRecord?.isVirtualOccurrence; form.elements.seriesEditScope.value = "only"; syncRepeatControls(form);
    document.querySelector("#record-dialog-title").textContent = record ? "Редактировать запись" : "Новая запись"; document.querySelector("#record-form-error").textContent = ""; dialog.showModal(); form.elements.title.focus();
  }
  function createException(parent, occurrenceDate, input, status = "active", completed = false) {
    const previousStatus = input.status === "archived" ? "archived" : "active"; const isCompleted = completed || (status === "trash" && previousStatus === "archived");
    const values = { ...parent, ...input, status, isCompleted, completedAt: isCompleted ? (input.completedAt || nowIso()) : null, deletedAt: status === "trash" ? nowIso() : null, statusBeforeTrash: status === "trash" ? previousStatus : null, repeat: null, seriesId: parent.seriesId, originalOccurrenceDate: occurrenceDate, startDate: input.startDate || occurrenceDate, endDate: input.endDate ?? occurrenceEnd(parent, input.startDate || occurrenceDate) };
    return plannerStore.createRecord(values);
  }
  function endParentBefore(parent, occurrenceDate) { const previous = shiftDateKey(occurrenceDate, -1); if (previous < parent.startDate) return false; plannerStore.replaceRecord(parent.id, { ...parent, repeat: { frequency: "daily", endCondition: "date", endValue: previous } }); return true; }
  function remainingRepeat(parent, occurrenceDate) { if (parent.repeat.endCondition === "never") return { ...parent.repeat }; if (parent.repeat.endCondition === "date") return { ...parent.repeat }; const remaining = parent.repeat.endValue - dateDifference(parent.startDate, occurrenceDate); return remaining > 0 ? { frequency: "daily", endCondition: "count", endValue: remaining } : null; }
  function applySeriesEdit(visualRecord, input, scope) {
    const parent = baseRecord(visualRecord); if (!parent) throw new PlannerValidationError("Серия не найдена.");
    if (scope === "only") { createException(parent, visualRecord.occurrenceDate, input); return; }
    const hasPast = endParentBefore(parent, visualRecord.occurrenceDate); const nextRepeat = remainingRepeat(parent, visualRecord.occurrenceDate); if (!nextRepeat) return;
    plannerStore.createRecord({ ...parent, ...input, startDate: input.startDate || visualRecord.occurrenceDate, repeat: nextRepeat, seriesId: createId("series"), originalOccurrenceDate: null, status: "active", isCompleted: false, completedAt: null, deletedAt: null, statusBeforeTrash: null });
    if (!hasPast) plannerStore.updateData((draft) => { draft.records = draft.records.filter((record) => record.id !== parent.id); });
  }
  function saveRecord(event) {
    event.preventDefault(); const form = event.currentTarget; const error = document.querySelector("#record-form-error"); const existing = form.elements.recordId.value ? plannerStore.getData().records.find((record) => record.id === form.elements.recordId.value) : null;
    try {
      const input = buildFormRecord(form, existing); if (input.startDate === null) { input.time = null; input.endDate = null; input.repeat = null; input.seriesId = null; }
      if (form.elements.occurrenceDate.value && existing?.repeat) { applySeriesEdit({ ...existing, occurrenceDate: form.elements.occurrenceDate.value, isVirtualOccurrence: true, parentId: existing.id, startDate: form.elements.occurrenceDate.value, endDate: occurrenceEnd(existing, form.elements.occurrenceDate.value) }, input, form.elements.seriesEditScope.value); }
      else if (existing) plannerStore.replaceRecord(existing.id, input); else plannerStore.createRecord(input);
      form.closest("dialog").close(); renderInterface();
    } catch (caught) { error.textContent = readableError(caught); }
  }
  let undoTimer = null;
  function showUndo(message, undo) { const notice = document.querySelector("#action-notice"); if (!notice) return; clearTimeout(undoTimer); notice.querySelector("p").textContent = message; notice.hidden = false; notice.querySelector("button").onclick = () => { try { undo(); notice.hidden = true; renderInterface(); } catch (caught) { window.alert(readableError(caught)); } }; undoTimer = window.setTimeout(() => { notice.hidden = true; }, 7000); }
  function completeRecord(record) { try { let undo; if (record.isVirtualOccurrence) { const parent = baseRecord(record); const exception = createException(parent, record.occurrenceDate, { ...record }, "archived", true); undo = () => deleteForever(exception); } else { const previous = { ...record }; plannerStore.replaceRecord(record.id, { ...record, status: "archived", isCompleted: true, completedAt: nowIso(), deletedAt: null, statusBeforeTrash: null }); undo = () => plannerStore.replaceRecord(previous.id, previous); } renderInterface(); showUndo("Запись перемещена в архив.", undo); } catch (caught) { window.alert(readableError(caught)); } }
  function archiveFutureSeries(record) {
    const parent = baseRecord(record); if (!parent) return; if (!endParentBefore(parent, record.occurrenceDate)) { plannerStore.replaceRecord(parent.id, { ...parent, status: "archived", isCompleted: true, completedAt: nowIso() }); return; }
    const repeat = remainingRepeat(parent, record.occurrenceDate); if (repeat) plannerStore.createRecord({ ...parent, startDate: record.occurrenceDate, endDate: occurrenceEnd(parent, record.occurrenceDate), repeat, status: "archived", isCompleted: true, completedAt: nowIso(), deletedAt: null, statusBeforeTrash: null });
  }
  function moveToTrash(record, scope = "only") {
    if (record.isVirtualOccurrence) { const parent = baseRecord(record); if (scope === "only") createException(parent, record.occurrenceDate, { ...record }, "trash"); else { if (!endParentBefore(parent, record.occurrenceDate)) { plannerStore.replaceRecord(parent.id, { ...parent, status: "trash", deletedAt: nowIso(), statusBeforeTrash: "active" }); } else { const repeat = remainingRepeat(parent, record.occurrenceDate); if (repeat) plannerStore.createRecord({ ...parent, startDate: record.occurrenceDate, endDate: occurrenceEnd(parent, record.occurrenceDate), repeat, status: "trash", deletedAt: nowIso(), statusBeforeTrash: "active" }); } } }
    else plannerStore.replaceRecord(record.id, { ...record, status: "trash", deletedAt: nowIso(), statusBeforeTrash: record.status, isCompleted: record.status === "archived" ? true : false, completedAt: record.status === "archived" ? record.completedAt : null });
  }
  function restoreRecord(record) { if (record.isVirtualOccurrence) { const parent = baseRecord(record); createException(parent, record.occurrenceDate, { ...record }, "active", false); } else { const status = record.statusBeforeTrash || "active"; plannerStore.replaceRecord(record.id, { ...record, status, deletedAt: null, statusBeforeTrash: null, isCompleted: status === "archived", completedAt: status === "archived" ? (record.completedAt || nowIso()) : null }); } }
  function deleteForever(record) { plannerStore.updateData((draft) => { draft.records = draft.records.filter((item) => item.id !== record.id); }); }
  async function chooseSeriesScope(title, message) { const dialog = document.querySelector("#series-action-dialog"); dialog.querySelector("#series-action-title").textContent = title; dialog.querySelector("#series-action-message").textContent = message; return new Promise((resolve) => { let settled = false; const settle = (choice) => { if (settled) return; settled = true; if (dialog.open) dialog.close(); resolve(choice); }; dialog.querySelectorAll("[data-series-choice]").forEach((button) => { button.onclick = () => settle(button.dataset.seriesChoice === "cancel" ? null : button.dataset.seriesChoice); }); dialog.oncancel = () => settle(null); dialog.onclose = () => settle(null); dialog.showModal(); }); }
  function openDetails(recordOrId) {
    const data = plannerStore.getData(); const record = typeof recordOrId === "object" ? recordOrId : data.records.find((item) => item.id === recordOrId); if (!record) return; const dialog = document.querySelector("#details-dialog"); const content = document.querySelector("#details-content"); content.replaceChildren();
    const headingRow = document.createElement("div"); headingRow.className = "dialog-heading"; const heading = document.createElement("h2"); heading.textContent = record.title; const close = document.createElement("button"); close.className = "close-dialog"; close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Закрыть окно"); close.addEventListener("click", () => dialog.close()); headingRow.append(heading, close);
    const category = data.categories.find((item) => item.id === record.categoryId); const info = document.createElement("p"); info.textContent = `${record.type === "event" ? "Событие" : "Задача"}${record.startDate ? `, ${record.startDate}${record.time ? ` в ${record.time}` : ""}` : ", Входящие"}${record.isVirtualOccurrence ? ", повторение" : ""}`; const description = document.createElement("p"); description.textContent = record.description || "Без описания"; const metadata = document.createElement("p"); metadata.className = "trash-meta"; metadata.textContent = `Категория: ${category?.name || "неизвестна"}. Создано: ${new Date(record.createdAt).toLocaleString("ru-RU")}. Изменено: ${new Date(record.updatedAt).toLocaleString("ru-RU")}.`;
    const actions = document.createElement("div"); actions.className = "dialog-actions"; let removal = null;
    const addAction = (label, callback, destructive = false) => { const button = document.createElement("button"); button.type = "button"; button.className = "today-button"; button.textContent = label; if (destructive) button.classList.add("reset-button"); button.addEventListener("click", callback); actions.append(button); };
    if (record.status === "active") {
      addAction("Редактировать", () => { dialog.close(); openRecordForm(record); });
      addAction("Дублировать", () => { dialog.close(); openRecordForm(null, { ...record, title: `${record.title} (копия)`, repeat: null, seriesId: null }); });
      addAction("Завершить", () => { completeRecord(record); dialog.close(); });
      if (record.isVirtualOccurrence) addAction("Завершить всю серию", () => { if (window.confirm("Завершить текущий и будущие экземпляры серии?")) { archiveFutureSeries(record); dialog.close(); renderInterface(); } });
      addAction("Удалить", async () => { const scope = record.isVirtualOccurrence ? await chooseSeriesScope("Удаление повторения", "Что удалить из повторяющейся серии?") : "only"; if (!scope || !window.confirm("Переместить запись в корзину?")) return; moveToTrash(record, scope); dialog.close(); renderInterface(); }, true);
    } else if (record.status === "archived") {
      addAction("Восстановить", () => { restoreRecord(record); dialog.close(); renderInterface(); });
      addAction("Удалить", async () => { const scope = record.isVirtualOccurrence ? await chooseSeriesScope("Удаление повторения", "Что удалить из повторяющейся серии?") : "only"; if (!scope || !window.confirm("Переместить запись в корзину?")) return; moveToTrash(record, scope); dialog.close(); renderInterface(); }, true);
    } else {
      const deleted = new Date(record.deletedAt); const expiry = new Date(deleted); expiry.setDate(expiry.getDate() + 30); removal = document.createElement("p"); removal.className = "trash-meta"; removal.textContent = `Будет удалено окончательно: ${expiry.toLocaleDateString("ru-RU")}.`;
      addAction("Восстановить", () => { restoreRecord(record); dialog.close(); renderInterface(); });
      addAction("Удалить навсегда", () => { if (window.confirm("Удалить запись без возможности восстановления?")) { deleteForever(record); dialog.close(); renderInterface(); } }, true);
    }
    content.append(headingRow, info, description, metadata); if (record.status === "trash") content.append(removal); content.append(actions); dialog.showModal();
  }
  function renderInbox(data = plannerStore.getData(), settings = plannerStore.getSettings()) { const list = document.querySelector("#inbox-list"); if (!list) return; list.replaceChildren(); const records = data.records.filter((record) => record.startDate === null && recordMatchesFilters(record, data.categories, settings)).sort(compareRecords); if (!records.length) { const empty = document.createElement("p"); empty.textContent = "Во входящих пока нет записей."; list.append(empty); } else records.forEach((record) => list.append(createRecordCard(record, data.categories))); }
  function renderTrash(data = plannerStore.getData()) { const list = document.querySelector("#trash-list"); if (!list) return; list.replaceChildren(); const records = data.records.filter((record) => record.status === "trash").sort((first, second) => second.deletedAt.localeCompare(first.deletedAt)); if (!records.length) { const empty = document.createElement("p"); empty.textContent = "Корзина пуста."; list.append(empty); return; } records.forEach((record) => { const card = createRecordCard(record, data.categories); const meta = document.createElement("p"); meta.className = "trash-meta"; const expiry = new Date(record.deletedAt); expiry.setDate(expiry.getDate() + 30); meta.textContent = `Удалено: ${new Date(record.deletedAt).toLocaleDateString("ru-RU")}. До удаления: ${Math.max(0, Math.ceil((expiry - new Date()) / 86400000))} дн.`; const wrapper = document.createElement("div"); wrapper.append(card, meta); list.append(wrapper); }); }
  function renderInterface() {
    const grid = document.querySelector("#week-grid"); const settings = plannerStore.getSettings(); const data = plannerStore.getData(); if (!grid) return; syncControls(settings, data.categories); document.querySelector("#calendar-title").textContent = settings.view === "day" ? "День" : settings.view === "month" ? "Месяц" : "Неделя"; document.querySelector(".calendar-status").textContent = settings.filters.status === "archived" ? "Архивные записи" : "Активные записи"; const selected = dateFromKey(settings.selectedDate); document.querySelector("#period-label").textContent = formatPeriod(selected, settings.view); document.querySelector("#period-picker").value = settings.selectedDate; grid.className = settings.view === "month" ? "month-grid" : settings.view === "day" ? "day-view" : "week-grid"; grid.replaceChildren(); if (settings.view === "month") renderMonth(grid, selected, data, settings); else if (settings.view === "day") renderDay(grid, selected, data, settings); else renderWeek(grid, selected, data, settings); document.querySelector(".empty-week-message").hidden = settings.view !== "week" || Array.from({ length: 7 }, (_, index) => recordsForDate(data, settings, toDateKey(addDays(getMonday(selected), index))).length).some(Boolean); renderInbox(data, settings); renderTrash(data); renderStorageNotice();
  }
  function cleanupExpiredTrash() { const cutoff = Date.now() - 30 * 86400000; const expired = plannerStore.getData().records.some((record) => record.status === "trash" && new Date(record.deletedAt).getTime() <= cutoff); if (expired) plannerStore.updateData((draft) => { draft.records = draft.records.filter((record) => record.status !== "trash" || new Date(record.deletedAt).getTime() > cutoff); }); }
  let pendingBackup = null;
  function exportBackup() {
    try {
      const backup = plannerStore.exportBackup(); const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `planner-backup-${toDateKey(new Date())}.json`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (caught) { window.alert(`Не удалось подготовить резервную копию: ${readableError(caught)}`); }
  }
  function showImportDialog(backup = null, error = "") {
    const dialog = document.querySelector("#import-dialog"); const summary = document.querySelector("#import-summary"); const message = document.querySelector("#import-error"); pendingBackup = backup; summary.textContent = backup ? `Будут импортированы записей: ${backup.data.records.length}, категорий: ${backup.data.categories.length}.` : "Файл резервной копии не импортирован."; message.textContent = error; dialog.showModal();
  }
  async function readImportFile(event) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try { const parsed = JSON.parse(await file.text()); showImportDialog(normalizeBackup(parsed)); } catch (caught) { showImportDialog(null, `Импорт отменён: ${readableError(caught)}`); }
  }
  function confirmImport() {
    if (!pendingBackup) return;
    try { plannerStore.replaceBackup(pendingBackup); pendingBackup = null; document.querySelector("#import-dialog").close(); renderInterface(); } catch (caught) { document.querySelector("#import-error").textContent = `Импорт не выполнен: ${readableError(caught)}`; }
  }
  function bindDatePicker() {
    const label = document.querySelector("#period-label"); const picker = document.querySelector("#period-picker"); if (!label || !picker) return;
    label.addEventListener("click", () => { picker.value = plannerStore.getSettings().selectedDate; if (typeof picker.showPicker === "function") picker.showPicker(); else { picker.focus(); picker.click(); } });
    picker.addEventListener("change", () => { if (picker.value) setCalendarState({ selectedDate: picker.value }); });
  }
  function bindInterface() {
    document.querySelector("#create-record")?.addEventListener("click", () => openRecordForm()); document.querySelector("#open-inbox")?.addEventListener("click", () => { const panel = document.querySelector("#inbox-panel"); panel.hidden = !panel.hidden; }); document.querySelector("#open-trash")?.addEventListener("click", () => { const panel = document.querySelector("#trash-panel"); panel.hidden = !panel.hidden; renderTrash(); }); document.querySelector("#open-archive")?.addEventListener("click", () => updateFilters({ status: "archived" })); document.querySelector("#open-categories")?.addEventListener("click", openCategories); document.querySelector("#record-form")?.addEventListener("submit", saveRecord); document.querySelector("#clear-record-date")?.addEventListener("click", () => { const form = document.querySelector("#record-form"); form.elements.startDate.value = ""; form.elements.endDate.value = ""; form.elements.time.value = ""; form.elements.repeatEnabled.checked = false; syncRepeatControls(form); }); document.querySelector("#record-form [name=repeatEnabled]")?.addEventListener("change", (event) => syncRepeatControls(event.currentTarget.form)); document.querySelector("#record-form [name=repeatEndCondition]")?.addEventListener("change", (event) => syncRepeatControls(event.currentTarget.form));
    document.querySelector("#category-form")?.addEventListener("submit", (event) => { event.preventDefault(); const form = event.currentTarget; try { plannerStore.createCategory({ name: form.elements.name.value, color: form.elements.color.value }); form.reset(); document.querySelector("#category-form-error").textContent = ""; renderCategories(); renderInterface(); } catch (caught) { document.querySelector("#category-form-error").textContent = readableError(caught); } }); document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { const target = document.querySelector(`#${button.dataset.close}`); if (target?.close) target.close(); else target.hidden = true; })); document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("mousedown", (event) => { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); })); document.addEventListener("click", (event) => { const filters = document.querySelector(".filters-panel"); if (filters?.open && !filters.contains(event.target)) filters.open = false; }); document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setCalendarState({ view: button.dataset.view }))); document.querySelector("#previous-period")?.addEventListener("click", () => navigatePeriod(-1)); document.querySelector("#next-period")?.addEventListener("click", () => navigatePeriod(1)); document.querySelector("#today-period")?.addEventListener("click", () => setCalendarState({ selectedDate: toDateKey(new Date()) })); document.querySelector("#global-search")?.addEventListener("input", (event) => updateFilters({ query: event.target.value })); document.querySelector("#filter-category")?.addEventListener("change", (event) => updateFilters({ categoryIds: event.target.value ? [event.target.value] : [] })); document.querySelector("#filter-status")?.addEventListener("change", (event) => updateFilters({ status: event.target.value })); document.querySelector("#filter-period")?.addEventListener("change", (event) => updateFilters({ period: event.target.value })); document.querySelector("#reset-filters")?.addEventListener("click", () => updateFilters({ categoryIds: [], status: "active", period: "open", dateFrom: null, dateTo: null, query: "" })); document.querySelector("#export-data")?.addEventListener("click", exportBackup); document.querySelector("#import-data")?.addEventListener("click", () => document.querySelector("#import-file")?.click()); document.querySelector("#import-file")?.addEventListener("change", readImportFile); document.querySelector("#confirm-import")?.addEventListener("click", confirmImport);
  }

  function getFilterRange(settings) {
    const period = settings.filters.period;
    const today = dateFromKey(toDateKey(new Date()));
    if (period === "current-day") return { from: toDateKey(today), to: toDateKey(today) };
    if (period === "current-week") { const start = getMonday(today); return { from: toDateKey(start), to: toDateKey(addDays(start, 6)) }; }
    if (period === "current-month") return { from: toDateKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: toDateKey(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
    if (period === "custom" && settings.filters.dateFrom && settings.filters.dateTo) return { from: settings.filters.dateFrom, to: settings.filters.dateTo };
    return null;
  }

  function isDateAllowed(key, settings) {
    const range = getFilterRange(settings);
    return !range || (key >= range.from && key <= range.to);
  }

  function recordMatchesFilters(record, categories, settings) {
    if (record.status !== settings.filters.status) return false;
    if (settings.filters.categoryIds.length && !settings.filters.categoryIds.includes(record.categoryId)) return false;
    const query = settings.filters.query.trim().toLocaleLowerCase("ru-RU");
    if (!query) return true;
    const category = categories.find((item) => item.id === record.categoryId);
    const type = record.type === "task" ? "задача" : "событие";
    return [record.title, record.description || "", category?.name || "", type].join(" ").toLocaleLowerCase("ru-RU").includes(query);
  }

  function recordsForDate(data, settings, key) {
    if (!isDateAllowed(key, settings)) return [];
    const visible = [];
    data.records.filter((record) => recordMatchesFilters(record, data.categories, settings)).forEach((record) => {
      if (!record.repeat) {
        if (occursOn(record, key)) visible.push(record);
        return;
      }
      const duration = record.type === "event" && record.endDate ? dateDifference(record.startDate, record.endDate) : 0;
      for (let offset = 0; offset <= duration; offset += 1) {
        const occurrenceDate = shiftDateKey(key, -offset);
        if (!isRepeatStart(record, occurrenceDate) || hasSeriesException(data.records, record.seriesId, occurrenceDate)) continue;
        visible.push({ ...record, startDate: occurrenceDate, endDate: occurrenceEnd(record, occurrenceDate), occurrenceDate, isVirtualOccurrence: true, parentId: record.id });
      }
    });
    return visible.sort(compareRecords);
  }

  function filterRecords(records, categories, settings) {
    const range = getFilterRange(settings);
    return records.filter((record) => {
      if (!recordMatchesFilters(record, categories, settings)) return false;
      if (!range) return true;
      return record.startDate !== null && record.startDate <= range.to && (record.endDate || record.startDate) >= range.from;
    });
  }

  function renderCategoryFilters(categories, selectedIds) {
    const holder = document.querySelector("#filter-categories");
    if (!holder) return;
    holder.replaceChildren();
    categories.forEach((category) => {
      const label = document.createElement("label"); label.className = "category-filter-option";
      const input = document.createElement("input"); input.type = "checkbox"; input.value = category.id; input.checked = selectedIds.includes(category.id); input.setAttribute("aria-label", category.name);
      const dot = document.createElement("i"); dot.className = "category-dot"; dot.style.setProperty("--category-color", category.color);
      label.append(input, dot, document.createTextNode(category.name)); holder.append(label);
    });
  }

  function syncControls(settings, categories) {
    document.querySelectorAll("[data-view]").forEach((button) => { const active = button.dataset.view === settings.view; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    renderCategoryFilters(categories, settings.filters.categoryIds);
    document.querySelector("#filter-status").value = settings.filters.status;
    document.querySelector("#filter-period").value = settings.filters.period;
    document.querySelector("#filter-date-from").value = settings.filters.dateFrom || "";
    document.querySelector("#filter-date-to").value = settings.filters.dateTo || "";
    document.querySelector("#filter-custom-range").hidden = settings.filters.period !== "custom";
    document.querySelector("#global-search").value = settings.filters.query;
  }

  function createDayAddButton(key) {
    const button = document.createElement("button"); button.type = "button"; button.className = "day-add"; button.textContent = "+"; button.title = "Добавить запись на этот день"; button.setAttribute("aria-label", "Добавить запись на этот день");
    button.addEventListener("click", (event) => { event.stopPropagation(); openRecordForm(null, { startDate: key }); });
    return button;
  }

  function renderWeek(grid, selected, data, settings) {
    const start = getMonday(selected); const formatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
    for (let index = 0; index < 7; index += 1) {
      const date = addDays(start, index); const key = toDateKey(date); const column = document.createElement("article"); column.className = `week-day${isSameDate(date, new Date()) ? " is-today" : ""}`; column.dataset.date = key;
      const header = document.createElement("header"); header.className = "day-header"; const name = document.createElement("p"); name.className = "day-name"; name.textContent = formatter.format(date).replace(".", ""); const number = document.createElement("time"); number.className = "day-number"; number.dateTime = key; number.textContent = date.getDate(); header.append(name, number, createDayAddButton(key)); column.append(header);
      const records = recordsForDate(data, settings, key); if (!records.length) { const empty = document.createElement("p"); empty.className = "day-empty"; empty.textContent = "Нет записей"; column.append(empty); }
      records.forEach((record) => column.append(createRecordCard(record, data.categories))); bindDropTarget(column); column.addEventListener("click", (event) => { if (!event.target.closest(".record-card-wrap") && !draggedRecordId) setCalendarState({ view: "day", selectedDate: key }); }); grid.append(column);
    }
  }

  function renderDay(grid, selected, data, settings) {
    const key = toDateKey(selected); const headingRow = document.createElement("div"); headingRow.className = "day-view-heading"; const heading = document.createElement("h3"); heading.textContent = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(selected); headingRow.append(heading, createDayAddButton(key)); grid.append(headingRow);
    const records = recordsForDate(data, settings, key); if (!records.length) { const empty = document.createElement("p"); empty.className = "day-empty"; empty.textContent = "Нет записей"; grid.append(empty); } else records.forEach((record) => grid.append(createRecordCard(record, data.categories)));
  }

  function createRecordCard(record, categories) {
    const category = categories.find((item) => item.id === record.categoryId); const wrapper = document.createElement("div"); wrapper.className = "record-card-wrap"; wrapper.draggable = record.status === "active"; wrapper.dataset.recordId = record.id;
    const button = document.createElement("button"); button.type = "button"; button.className = `record-card${record.status === "archived" ? " is-archived" : ""}`; button.style.setProperty("--category-color", category.color); button.style.backgroundColor = record.status === "archived" ? "" : hexToRgba(category.color, .2);
    const type = document.createElement("span"); type.className = "card-type"; type.textContent = record.status === "archived" ? `Архив - ${category.name}` : record.type === "event" ? "Календарь" : "Задача"; const text = document.createElement("span"); const title = document.createElement("strong"); title.textContent = record.title; text.append(title); if (record.time) { const time = document.createElement("small"); time.textContent = record.time; text.append(time); } button.append(type, text);
    if (record.status === "active") { const complete = document.createElement("input"); complete.type = "checkbox"; complete.className = "complete-record"; complete.setAttribute("aria-label", "Завершить запись"); complete.addEventListener("change", () => completeRecord(record)); wrapper.append(complete); }
    button.addEventListener("click", () => openDetails(record)); wrapper.append(button); wrapper.addEventListener("dragstart", (event) => { draggedRecordId = record; event.dataTransfer.effectAllowed = "move"; }); wrapper.addEventListener("dragend", () => { draggedRecordId = null; }); return wrapper;
  }

  function bindDropTarget(column) { column.addEventListener("dragover", (event) => { event.preventDefault(); column.classList.add("is-drop-target"); }); column.addEventListener("dragleave", () => column.classList.remove("is-drop-target")); column.addEventListener("drop", async (event) => { event.preventDefault(); column.classList.remove("is-drop-target"); await moveRecordToDate(draggedRecordId, column.dataset.date); }); }
  function isPastOccurrence(record) { return Boolean(record?.isVirtualOccurrence && record.occurrenceDate < toDateKey(new Date())); }
  async function moveRecordToDate(record, date) {
    if (!record || !record.startDate || record.startDate === date) return;
    if (isPastOccurrence(record)) { window.alert("Прошедший экземпляр повторения нельзя редактировать."); return; }
    if (record.isVirtualOccurrence) { const scope = await chooseSeriesScope("Перенос повторения", "Как перенести повторяющийся экземпляр?"); if (!scope) return; const input = { ...record, startDate: date, endDate: record.endDate ? shiftDateKey(record.endDate, dateDifference(record.startDate, date)) : null }; applySeriesEdit(record, input, scope); }
    else { const delta = dateDifference(record.startDate, date); plannerStore.replaceRecord(record.id, { ...record, startDate: date, endDate: record.endDate ? shiftDateKey(record.endDate, delta) : null }); }
    renderInterface();
  }

  async function moveRecordToInbox(record) {
    if (!record || record.status !== "active" || record.startDate === null) return;
    if (!window.confirm("Перенести запись во «Входящие»? Дата, время и дата окончания будут очищены.")) return;
    try {
      if (record.isVirtualOccurrence) {
        if (isPastOccurrence(record)) throw new PlannerValidationError("Прошедший экземпляр повторения нельзя редактировать.");
        const scope = await chooseSeriesScope("Перенос повторения", "Во «Входящие» можно перенести отдельный экземпляр серии.");
        if (scope !== "only") return;
        const parent = baseRecord(record);
        plannerStore.createRecord({ ...parent, ...record, startDate: null, endDate: null, time: null, repeat: null, seriesId: parent.seriesId, originalOccurrenceDate: record.occurrenceDate, status: "active", isCompleted: false, completedAt: null, deletedAt: null, statusBeforeTrash: null });
      } else plannerStore.replaceRecord(record.id, { ...record, startDate: null, endDate: null, time: null, repeat: null, seriesId: null, originalOccurrenceDate: null });
      renderInterface();
    } catch (caught) { window.alert(readableError(caught)); }
  }

  function bindInboxDropTarget(target) {
    if (!target) return;
    target.addEventListener("dragover", (event) => { event.preventDefault(); target.classList.add("is-drop-target"); });
    target.addEventListener("dragleave", () => target.classList.remove("is-drop-target"));
    target.addEventListener("drop", async (event) => { event.preventDefault(); target.classList.remove("is-drop-target"); await moveRecordToInbox(draggedRecordId); });
  }

  function syncRecordFormFields(form) {
    const hasDate = Boolean(form.elements.startDate.value); const isEvent = form.elements.type.value === "event"; const isVirtual = Boolean(form.elements.occurrenceDate.value);
    const timeField = document.querySelector("#record-time-field"); const endField = document.querySelector("#record-end-date-field"); const repeatChoice = form.querySelector(".repeat-choice");
    timeField.hidden = !hasDate; form.elements.time.disabled = !hasDate; if (!hasDate) form.elements.time.value = "";
    endField.hidden = !hasDate || !isEvent; form.elements.endDate.disabled = !hasDate || !isEvent; if (!hasDate || !isEvent) form.elements.endDate.value = "";
    repeatChoice.hidden = !hasDate || isVirtual; if (!hasDate || isVirtual) form.elements.repeatEnabled.checked = false;
    const category = plannerStore.getData().categories.find((item) => item.id === form.elements.categoryId.value); const dot = document.querySelector("#record-category-dot"); if (dot && category) dot.style.setProperty("--category-color", category.color);
    syncRepeatControls(form);
  }

  function openRecordForm(recordOrId = null, seed = {}) {
    const dialog = document.querySelector("#record-dialog"); const form = document.querySelector("#record-form"); const data = plannerStore.getData(); const visualRecord = typeof recordOrId === "object" ? recordOrId : null; const record = typeof recordOrId === "string" ? data.records.find((item) => item.id === recordOrId) : visualRecord || null; const parent = visualRecord?.isVirtualOccurrence ? baseRecord(visualRecord) : null;
    if (isPastOccurrence(visualRecord)) { window.alert("Прошедший экземпляр повторения нельзя редактировать."); return; }
    form.reset(); form.elements.recordId.value = parent?.id || record?.id || ""; form.elements.occurrenceDate.value = visualRecord?.occurrenceDate || ""; form.elements.title.value = record?.title || seed.title || ""; form.elements.type.value = record?.type || seed.type || "task"; form.elements.categoryId.replaceChildren(...data.categories.map((category) => new Option(category.name, category.id))); form.elements.categoryId.value = record?.categoryId || seed.categoryId || "personal"; form.elements.startDate.value = record?.startDate || seed.startDate || ""; form.elements.endDate.value = record?.endDate || seed.endDate || ""; form.elements.time.value = record?.time || seed.time || ""; form.elements.description.value = record?.description || seed.description || "";
    const rawRepeat = parent?.repeat || record?.repeat || null; form.elements.repeatEnabled.checked = rawRepeat !== null; form.elements.repeatEndCondition.value = rawRepeat?.endCondition || "date"; form.elements.repeatEndValue.value = rawRepeat?.endValue || ""; document.querySelector("#series-edit-scope").hidden = !visualRecord?.isVirtualOccurrence; form.elements.seriesEditScope.value = "only"; document.querySelector("#inline-category-fields").hidden = true; document.querySelector("#record-dialog-title").textContent = record ? "Редактировать запись" : "Новая запись"; document.querySelector("#record-form-error").textContent = ""; syncRecordFormFields(form); dialog.showModal(); form.elements.title.focus();
  }

  function saveRecord(event) {
    event.preventDefault(); const form = event.currentTarget; const error = document.querySelector("#record-form-error"); const existing = form.elements.recordId.value ? plannerStore.getData().records.find((record) => record.id === form.elements.recordId.value) : null;
    try {
      if (form.elements.occurrenceDate.value < toDateKey(new Date())) throw new PlannerValidationError("Прошедший экземпляр повторения нельзя редактировать.");
      const input = buildFormRecord(form, existing); if (input.startDate === null) { input.time = null; input.endDate = null; input.repeat = null; input.seriesId = null; }
      if (form.elements.occurrenceDate.value && existing?.repeat) applySeriesEdit({ ...existing, occurrenceDate: form.elements.occurrenceDate.value, isVirtualOccurrence: true, parentId: existing.id, startDate: form.elements.occurrenceDate.value, endDate: occurrenceEnd(existing, form.elements.occurrenceDate.value) }, input, form.elements.seriesEditScope.value);
      else if (existing) plannerStore.replaceRecord(existing.id, input); else plannerStore.createRecord(input);
      form.closest("dialog").close(); renderInterface();
    } catch (caught) { error.textContent = readableError(caught); }
  }

  function openDetails(recordOrId) {
    const data = plannerStore.getData(); const record = typeof recordOrId === "object" ? recordOrId : data.records.find((item) => item.id === recordOrId); if (!record) return; const dialog = document.querySelector("#details-dialog"); const content = document.querySelector("#details-content"); content.replaceChildren();
    const headingRow = document.createElement("div"); headingRow.className = "dialog-heading"; const heading = document.createElement("h2"); heading.textContent = record.title; const close = document.createElement("button"); close.className = "close-dialog"; close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Закрыть окно"); close.addEventListener("click", () => dialog.close()); headingRow.append(heading, close);
    const category = data.categories.find((item) => item.id === record.categoryId); const info = document.createElement("p"); info.textContent = `${record.type === "event" ? "Событие" : "Задача"}${record.startDate ? `, ${record.startDate}${record.time ? ` в ${record.time}` : ""}` : ", Входящие"}${record.isVirtualOccurrence ? ", повторение" : ""}`; const description = document.createElement("p"); description.textContent = record.description || "Без описания"; const metadata = document.createElement("p"); metadata.className = "trash-meta"; metadata.textContent = `Категория: ${category?.name || "неизвестна"}. Создано: ${new Date(record.createdAt).toLocaleString("ru-RU")}. Изменено: ${new Date(record.updatedAt).toLocaleString("ru-RU")}.`;
    const actions = document.createElement("div"); actions.className = "dialog-actions"; let removal = null; const addAction = (label, callback, destructive = false) => { const button = document.createElement("button"); button.type = "button"; button.className = "today-button"; button.textContent = label; if (destructive) button.classList.add("reset-button"); button.addEventListener("click", callback); actions.append(button); };
    if (record.status === "active") {
      if (!isPastOccurrence(record)) addAction("Редактировать", () => { dialog.close(); openRecordForm(record); });
      addAction("Дублировать", () => { dialog.close(); openRecordForm(null, { ...record, title: `${record.title} (копия)`, repeat: null, seriesId: null }); }); addAction("Завершить", () => { completeRecord(record); dialog.close(); }); if (record.isVirtualOccurrence) addAction("Завершить всю серию", () => { if (window.confirm("Завершить текущий и будущие экземпляры серии?")) { archiveFutureSeries(record); dialog.close(); renderInterface(); } }); addAction("Удалить", async () => { const scope = record.isVirtualOccurrence ? await chooseSeriesScope("Удаление повторения", "Что удалить из повторяющейся серии?") : "only"; if (!scope || !window.confirm("Переместить запись в корзину?")) return; moveToTrash(record, scope); dialog.close(); renderInterface(); }, true);
    } else if (record.status === "archived") { addAction("Восстановить", () => { restoreRecord(record); dialog.close(); renderInterface(); }); addAction("Удалить", async () => { const scope = record.isVirtualOccurrence ? await chooseSeriesScope("Удаление повторения", "Что удалить из повторяющейся серии?") : "only"; if (!scope || !window.confirm("Переместить запись в корзину?")) return; moveToTrash(record, scope); dialog.close(); renderInterface(); }, true); }
    else { const expiry = new Date(record.deletedAt); expiry.setDate(expiry.getDate() + 30); removal = document.createElement("p"); removal.className = "trash-meta"; removal.textContent = `Будет удалено окончательно: ${expiry.toLocaleDateString("ru-RU")}.`; addAction("Восстановить", () => { restoreRecord(record); dialog.close(); renderInterface(); }); addAction("Удалить навсегда", () => { if (window.confirm("Удалить запись без возможности восстановления?")) { deleteForever(record); dialog.close(); renderInterface(); } }, true); }
    content.append(headingRow, info, description, metadata); if (removal) content.append(removal); content.append(actions); dialog.showModal();
  }

  function renderInbox(data = plannerStore.getData(), settings = plannerStore.getSettings()) { const list = document.querySelector("#inbox-list"); if (!list) return; list.replaceChildren(); const records = filterRecords(data.records, data.categories, settings).filter((record) => record.startDate === null).sort(compareRecords); if (!records.length) { const empty = document.createElement("p"); empty.textContent = "Во входящих пока нет записей."; list.append(empty); } else records.forEach((record) => list.append(createRecordCard(record, data.categories))); }

  function renderInterface() {
    const grid = document.querySelector("#week-grid"); const settings = plannerStore.getSettings(); const data = plannerStore.getData(); if (!grid) return; syncControls(settings, data.categories); document.querySelector("#calendar-title").textContent = settings.view === "day" ? "День" : settings.view === "month" ? "Месяц" : "Неделя"; document.querySelector(".calendar-status").textContent = settings.filters.status === "archived" ? "Архивные записи" : "Активные записи"; const selected = dateFromKey(settings.selectedDate); document.querySelector("#period-label").textContent = formatPeriod(selected, settings.view); document.querySelector("#period-picker").value = settings.selectedDate; grid.className = settings.view === "month" ? "month-grid" : settings.view === "day" ? "day-view" : "week-grid"; grid.replaceChildren(); if (settings.view === "month") renderMonth(grid, selected, data, settings); else if (settings.view === "day") renderDay(grid, selected, data, settings); else renderWeek(grid, selected, data, settings); document.querySelector(".empty-week-message").hidden = settings.view !== "week" || Array.from({ length: 7 }, (_, index) => recordsForDate(data, settings, toDateKey(addDays(getMonday(selected), index))).length).some(Boolean); renderInbox(data, settings); renderTrash(data); renderStorageNotice();
  }

  function bindInterface() {
    const form = document.querySelector("#record-form");
    document.querySelector("#create-record")?.addEventListener("click", () => openRecordForm()); document.querySelector("#create-today")?.addEventListener("click", () => openRecordForm(null, { startDate: toDateKey(new Date()) })); document.querySelector("#create-tomorrow")?.addEventListener("click", () => openRecordForm(null, { startDate: shiftDateKey(toDateKey(new Date()), 1) }));
    document.querySelector("#open-inbox")?.addEventListener("click", () => { const panel = document.querySelector("#inbox-panel"); panel.hidden = !panel.hidden; if (!panel.hidden) renderInbox(); }); document.querySelector("#open-trash")?.addEventListener("click", () => { const panel = document.querySelector("#trash-panel"); panel.hidden = !panel.hidden; renderTrash(); }); document.querySelector("#open-archive")?.addEventListener("click", () => updateFilters({ status: "archived" })); document.querySelector("#open-categories")?.addEventListener("click", openCategories);
    form?.addEventListener("submit", saveRecord); form?.elements.startDate.addEventListener("change", () => syncRecordFormFields(form)); form?.querySelectorAll("[name=type]").forEach((input) => input.addEventListener("change", () => syncRecordFormFields(form))); form?.elements.categoryId.addEventListener("change", () => syncRecordFormFields(form)); form?.elements.repeatEnabled.addEventListener("change", () => syncRecordFormFields(form)); form?.elements.repeatEndCondition.addEventListener("change", () => syncRecordFormFields(form));
    document.querySelector("#clear-record-date")?.addEventListener("click", () => { if (form.elements.startDate.value && !window.confirm("Перенести запись во «Входящие»? Дата, время и дата окончания будут очищены.")) return; form.elements.startDate.value = ""; form.elements.endDate.value = ""; form.elements.time.value = ""; form.elements.repeatEnabled.checked = false; syncRecordFormFields(form); });
    document.querySelector("#open-inline-category")?.addEventListener("click", () => { const fields = document.querySelector("#inline-category-fields"); fields.hidden = !fields.hidden; if (!fields.hidden) form.elements.newCategoryName.focus(); }); document.querySelector("#create-inline-category")?.addEventListener("click", () => { try { const category = plannerStore.createCategory({ name: form.elements.newCategoryName.value, color: form.elements.newCategoryColor.value }); form.elements.categoryId.add(new Option(category.name, category.id)); form.elements.categoryId.value = category.id; form.elements.newCategoryName.value = ""; document.querySelector("#inline-category-fields").hidden = true; syncRecordFormFields(form); renderInterface(); } catch (caught) { document.querySelector("#record-form-error").textContent = readableError(caught); } });
    document.querySelector("#category-form")?.addEventListener("submit", (event) => { event.preventDefault(); const categoryForm = event.currentTarget; try { plannerStore.createCategory({ name: categoryForm.elements.name.value, color: categoryForm.elements.color.value }); categoryForm.reset(); document.querySelector("#category-form-error").textContent = ""; renderCategories(); renderInterface(); } catch (caught) { document.querySelector("#category-form-error").textContent = readableError(caught); } });
    document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { const target = document.querySelector(`#${button.dataset.close}`); if (target?.close) target.close(); else target.hidden = true; })); document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("mousedown", (event) => { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); })); document.addEventListener("click", (event) => { const filters = document.querySelector(".filters-panel"); if (filters?.open && !filters.contains(event.target)) filters.open = false; });
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setCalendarState({ view: button.dataset.view }))); document.querySelector("#previous-period")?.addEventListener("click", () => navigatePeriod(-1)); document.querySelector("#next-period")?.addEventListener("click", () => navigatePeriod(1)); document.querySelector("#today-period")?.addEventListener("click", () => setCalendarState({ selectedDate: toDateKey(new Date()) })); document.querySelector("#global-search")?.addEventListener("input", (event) => updateFilters({ query: event.target.value })); document.querySelector("#filter-categories")?.addEventListener("change", () => updateFilters({ categoryIds: Array.from(document.querySelectorAll("#filter-categories input:checked"), (input) => input.value) })); document.querySelector("#filter-status")?.addEventListener("change", (event) => updateFilters({ status: event.target.value })); document.querySelector("#filter-period")?.addEventListener("change", (event) => updateFilters({ period: event.target.value })); document.querySelector("#filter-date-from")?.addEventListener("change", (event) => updateFilters({ dateFrom: event.target.value || null })); document.querySelector("#filter-date-to")?.addEventListener("change", (event) => updateFilters({ dateTo: event.target.value || null })); document.querySelector("#reset-filters")?.addEventListener("click", () => updateFilters({ categoryIds: [], status: "active", period: "open", dateFrom: null, dateTo: null, query: "" })); document.querySelector("#export-data")?.addEventListener("click", exportBackup); document.querySelector("#import-data")?.addEventListener("click", () => document.querySelector("#import-file")?.click()); document.querySelector("#import-file")?.addEventListener("change", readImportFile); document.querySelector("#confirm-import")?.addEventListener("click", confirmImport);
    bindInboxDropTarget(document.querySelector("#open-inbox")); bindInboxDropTarget(document.querySelector("#inbox-panel"));
  }

  const plannerStore = createStore();
  window.PlannerStorage = Object.freeze({
    createStore,
    createInitialData,
    createInitialSettings,
    PlannerStorageError,
    PlannerValidationError,
  });
  window.plannerStore = plannerStore;

  cleanupExpiredTrash();
  bindInterface();
  bindDatePicker();
  renderInterface();
})();
