// Стенд «Заключение ДП» (19.11.2026: заявки на заключение ДП — карточки доски проверки ДП/ДС, раздела /dp-requests нет). Данные —
// seed.js с ?docCheck=1&dcDpc=1 (карточки «Заключение ДП», получатели и уведомления большого окна):
//   route=/stand/dp-create — кнопка «+ Заявка на заключение ДП» «Реестра по договорам» (без самого реестра) и большое окно;
//   route=/stand/dp-alert  — большое окно на посторонней странице.
// Люди и объекты вымышленные.
import DpRequestAlert from '../../../src/components/dpRequests/DpRequestAlert'
import DpRequestCreateButton from '../../../src/components/dpRequests/DpRequestCreateButton'

export default function DpStand({ button = false }) {
  return (
    <>
      <DpRequestAlert />
      {button
        ? <div data-testid="registry-button"><DpRequestCreateButton /></div>
        : <div data-testid="other-page">Посторонняя страница</div>}
    </>
  )
}
