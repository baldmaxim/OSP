# Карта прав по коду: таблица → разделы интерфейса (вход для Р2c)

> Собрано 2026-10-08 по `src/` (все `db.from` / `db.rpc`). Пути — от `src/`, номера строк на коммит
> `f9f2dd3`. Персональных данных нет. Принцип Р2: **сервер разрешает ровно то, что разрешает интерфейс**.
> Сокращения: S/I/U/D/Up — чтение/вставка/изменение/удаление/upsert; E(x) — `canEdit(x)`.

## Гейты маршрутов (`App.jsx`)

| Раздел | Страницы |
|---|---|
| objects | ObjectsPage, ObjectDetailPage |
| contacts | ContactsPage |
| counterparties | CounterpartiesPage |
| general_documents | GeneralDocumentsPage |
| tasks | TasksPage |
| tenders | TendersHubPage, TendersPage (стройка/гарантия/совместные/прочие), TenderDetailPage, CostPlansPage, KpReviewPage, SummaryPage |
| tenders **или** tenders_materials | TendersPage — тендеры на материалы |
| tenders **или** vors | VorsPage |
| analysis_kp | BSMPage (к базе не обращается) |
| contracts | ContractsPage, PsdcBatchPage, ContractDetailPage |
| dc_requests | DcRequestsPage |
| doc_check_requests | DocCheckRequestsPage |
| rates_registry | RatesRegistryPage |
| reports | ReportsPage |
| admin | AdminPage (+ `isAdmin || isSuperAdmin`) |
| любой одобренный сотрудник | уведомления, `/general`, профиль |

Недоступные из интерфейса страницы (не импортируются): DocumentCheckPage, AcceptancePage, BSMContractRatesPage,
BSMContractorRatesPage, BSMRatesPage, BSMComparisonPage, BSMSelectionPage, ContractRegistry, GeneralInfo.
Значит, у `bsm_*`, `document_check_requests`, `document_check_request_history` **живого доступа из
интерфейса нет**.

## Таблица → кто читает, кто пишет, чем ограничено в интерфейсе

### Объекты
| Таблица | Пишут | Гейт записи | Читают ещё |
|---|---|---|---|
| objects | ObjectsPage (I/U/D, импорт Excel, **удаление — не только админ**), ObjectDetailPage | E(objects) | почти все разделы (справочники), витрина (anon), кабинет подрядчика |
| object_staff, object_documents, object_estimate_items, object_warranties, object_warranty_retentions, object_warranty_retention_payments, object_areas | ObjectDetailPage | E(objects); смета — ещё «смета не утверждена» | экспорт объектов |
| object_contract_attachments | ContractsPage | **E(contracts)** | ContractDetailPage |
| storage `object-photos` | ObjectsPage | E(objects) | — |

### Справочники
| Таблица | Пишут | Гейт записи | Читают ещё |
|---|---|---|---|
| contacts, positions, departments | ContactsPage | E(contacts) | objects, tenders, contracts, dc_requests, vors |
| counterparties | CounterpartiesPage; **окончательное удаление — isAdmin** | E(counterparties) | contracts, tenders, dc_requests, admin, кабинет (своя) |
| counterparty_contacts, counterparty_relations, work_types, counterparty_audit_log | CounterpartiesPage | E(counterparties) | tenders (контакты) |
| general_documents, general_document_links, general_document_folders | GeneralDocumentsPage | E(general_documents) | — |

### Задачи
| Таблица | Пишут | Гейт записи |
|---|---|---|
| tasks | TasksPage, TaskDetailModal, services/tasks.js | создать — E(tasks); править/удалить — E(tasks) **или автор**; статус — ещё **исполнитель** |
| task_participants, task_checklist_items | то же | E(tasks) или автор; отметка пункта — ещё исполнитель |
| task_comments | TaskDetailModal | **нет гейта**: любой, кто видит задачу |
| task_audit_log | services/tasks.js | пишется при каждой правке |
| employee_directory (вью) | — (только чтение) | — |

### Тендеры
| Таблица | Пишут | Гейт записи |
|---|---|---|
| tenders | TendersPage (статус, ответственные, ссылки, папка, РД, письмо, `materials_*`, форма, вставка, победитель) | `canEditTenders` = E(tenders) **или** (вид «материалы» **и** E(tenders_materials)) |
| tenders `tg_published*` | TendersPage | то же **или роль economist** |
| tenders — мягкое и окончательное удаление | TendersPage | **isAdmin** |
| tenders `work_description` (синхронизация детей на чтении) | TendersPage | **нет гейта**: любой зритель списка материалов |
| tenders `cost_plan_*` | CostPlansPage | **нет гейта**: любой с правом видеть тендеры |
| tenders `vor_*` | VorsPage | E(tenders) **или** E(vors) |
| tender_counterparties | TendersPage, TenderDetailPage, кабинет (свои строки, только статус) | canEditTenders / E(tenders) |
| tender_counterparty_proposals | TenderDetailPage, TenderProposalUploadModal, TenderProposalsCompare; кабинет (свои) | E(tenders) |
| tender_proposal_files | TenderCounterpartyFiles и др. | вставка/удаление — canEditTenders; **проверка КП — роль** admin/суперадмин/economist; замечания — admin/суперадмин/engineer; стадия — **суперадмин** |
| tender_estimate_items, tender_vor_supply_rates, tender_winners, tender_docs, tender_doc_links | TenderDetailPage, TendersPage | E(tenders) / canEditTenders |
| tender_rd_codes, tender_rd_document_codes | TenderRdCodesTab, TenderVorRdPanel | E(tenders); в «ВОРах и РД» — E(tenders) **или** E(vors) |
| tender_audit_log | TendersPage, TenderDetailPage, CostPlansPage, VorsPage | пишется при правках |
| vor_requests | VorsPage, VorRequestModal | E(tenders) **или** E(vors); читает ещё reports |

### Договоры
| Таблица | Пишут | Гейт записи |
|---|---|---|
| contracts | ContractsPage, ContractDetailPage, ContractsImportModal | E(contracts); **окончательное удаление — isAdmin** |
| contract_counterparties, contract_appendices, contract_advance_schedule | ContractsPage, ContractDetailPage | E(contracts) |
| contract_attachments | — (только чтение) | — |
| contract_audit_log | ContractsPage, ContractDetailPage | пишется при правках |
| contract_clause_disputes | ContractClausesTab | сотрудник — E(contracts); подрядчик — свои, только `counterparty_text` |
| contract_clause_comments | ContractClausesTab | **нет гейта**: любой зритель договора и подрядчик |
| contract_clauses | — (кабинет читает) | — |
| psdc* | только RPC `psdc_*` (права — на сервере, `psdc_contracts_permission`) | E(contracts) |

### Заявки, реестр, настройки, администрирование
| Таблица | Пишут | Гейт записи |
|---|---|---|
| dc_requests, dc_request_tasks, dc_request_audit_log | DcRequestsPage | E(dc_requests); выход из «проверки по договору» — admin/суперадмин/lawyer; **окончательное удаление — isAdmin только в интерфейсе** |
| doc_check_requests, doc_check_request_audit_log | DocCheckRequestsPage | E(doc_check_requests) |
| kp_/supply_rates_registry и фильтры | — (чтение) | раздел rates_registry; `refresh_rates_registry` — **любой зритель реестра** |
| app_settings | TendersPage (дежурный — **isAdmin**), RootFolderPathButton (canEditTenders / E(tenders) / E(contracts)), DcRequestsPage (E(dc_requests)) | по ключу |
| user_roles | вход (своя строка), профиль (свои 3 поля), AdminPage | см. ниже |
| roles, role_permissions | AdminPage | admin; читают все (роли — даже аноним, с запасным вариантом) |

### `s3_documents` по `owner_type`
| owner_type | Гейт загрузки и удаления |
|---|---|
| tender | E(tenders) / E(tenders\|vors); **пакет тендера (VorDocsModal) — без гейта**: любой сотрудник на странице |
| contract | E(contracts); **список файлов в карточке договора — без гейта**: любой зритель договоров |
| object | E(objects) |
| counterparty | E(counterparties) |
| dc_request | E(dc_requests) |
| doc_check_request | E(doc_check_requests) |
| general_document | E(general_documents) |
| task | **любой зритель задачи** |
| general (заявки на ВОР, ПСДЦ) | E(tenders\|vors); ПСДЦ — contracts |

## Кабинет подрядчика (организация — `user_roles.counterparty_id`)
- **Читает:** свою строку `user_roles`, свою `counterparties`, `roles`, свои `tender_counterparties` (+ тендеры
  и объекты), свои `contracts` и через `contract_counterparties`, `contract_clauses`, `tender_estimate_items`
  приглашённого тендера, `s3_documents` тендера (пакет, РД, ВОР) и договора, свои
  `tender_counterparty_proposals`, свои `contract_clause_disputes` и комментарии к ним.
- **Пишет:** свои предложения (удалить и вставить), `tender_counterparties.status` (`proposal_provided` /
  `declined`), разногласия (вставка, только `counterparty_text`), комментарии, свою строку `user_roles` при
  первом входе.
- **Опирается только на подрядческие политики** — широкие ему не нужны.
- `s3-presign` сейчас отдаёт подрядчику только файлы договоров: документы тендера из кабинета не
  скачиваются (Р2f).

## Витрина (`PublicTendersPage`, аноним)
`tenders`: id, public_tender_number, work_description, даты, status, tender_package_link, tender_type,
deleted_at, `objects(name, address, map_link, status)`. Фильтры `deleted_at`, `tender_type`, статус объекта —
**только на клиенте**: функция витрины (Р2e) должна делать их на сервере.

## Вход и роль
- Своя строка `user_roles` — до проверки одобрения; саморегистрация: `engineer` или `contractor`, не одобрен.
- Суперадмин (адрес в коде) сам себе ставит `admin` и одобрение.
- Одобренный сотрудник читает `role_permissions` своей роли.
- `touch_last_login` после входа.
- **Профиль:** свои `full_name` / `work_phone` / `work_email` — сейчас не сохраняется у не-админа (Р2h).

## Что пишут в «чужие» таблицы (учесть в Р2c)
- **vors** (без tenders) → `tenders.vor_*`, `tender_audit_log`, файлы тендера (РД, ВОР), `tender_rd_codes`,
  `tender_rd_document_codes`, `vor_requests`.
- **tenders_materials** (без tenders) → `tenders` (материалы), участники, победители, файлы КП,
  `app_settings` (`tenders_root_folder_path:materials`).
- **Зритель тендеров** → `tenders.cost_plan_*`; зритель списка материалов → синхронизация
  `work_description`.
- **Роль economist / engineer** → `tg_published*`, проверка КП и замечания.
- **contracts** → `object_contract_attachments`, суммы через ПСДЦ; зритель договоров → файлы договора,
  комментарии, ИИ.
- **objects** → `object_staff`.
- **counterparties** → каскад `work_type`; **contacts** → каскад `position`.
- **Зритель задачи** → комментарии, файлы; исполнитель → статус и отметки.
