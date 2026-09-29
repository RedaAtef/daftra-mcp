// ملاحظة: لو ظهر خطأ "UNABLE_TO_VERIFY_LEAF_SIGNATURE" فده معناه إن برنامج حماية (زي
// Avast) بيعمل فحص HTTPS ومحتاج شهادته مُضافة عبر متغيّر بيئة NODE_EXTRA_CA_CERTS.
// هذا المتغيّر لازم يكون مضبوطًا في إعدادات تشغيل السيرفر (claude_desktop_config.json)
// نفسها قبل بدء العملية — تعيينه من داخل الكود هنا لا يعمل لأن Node يقرأه مرة واحدة فقط
// عند الإقلاع.
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const API_KEY = process.env.DAFTRA_API_KEY || "";
const SUBDOMAIN = process.env.DAFTRA_SUBDOMAIN || "";
// موثّق في developer portal الرسمي (docs.daftara.dev) كـ {{subdomain}}.daftara.com/api2،
// لكن روابط الواجهة الفعلية (PDF/QR) تستخدم daftra.com بدون "a" إضافية. قابل للتجاوز لو ظهر خطأ اتصال.
const DOMAIN = process.env.DAFTRA_API_DOMAIN || "daftra.com";
const BASE_URL = `https://${SUBDOMAIN}.${DOMAIN}/api2`;

const server = new Server(
  { name: "daftra-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

function credsError() {
  if (!API_KEY || !SUBDOMAIN) {
    return "خطأ: بيانات الاتصال بـ Daftra غير مكتملة. يجب ضبط DAFTRA_API_KEY و DAFTRA_SUBDOMAIN كمتغيرات بيئة قبل تشغيل السكريبت.";
  }
  return null;
}

// طلب GET فقط (هذا السيرفر للقراءة/المراجعة فقط، لا توجد أي أداة كتابة أو تعديل)
async function daftraGet(path, query) {
  const url = new URL(`${BASE_URL}${path}.json`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { apikey: API_KEY, Accept: "application/json" }
    });
  } catch (e) {
    const cause = e.cause ? ` (${e.cause.code || ""} ${e.cause.message || e.cause})` : "";
    throw new Error(`تعذّر الاتصال بـ ${url.origin}${cause}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`رد غير متوقع من Daftra (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(`خطأ من Daftra API (HTTP ${res.status}): ${json.message || JSON.stringify(json)}`);
  }
  return json;
}

function formatResult(json) {
  const count = Array.isArray(json.data) ? json.data.length : (json.data ? 1 : 0);
  const pag = json.pagination
    ? ` | صفحة ${json.pagination.page} من ${json.pagination.page_count} (إجمالي ${json.pagination.total_results})`
    : "";
  return `تم الجلب بنجاح: ${count} عنصر${pag}\n\n${JSON.stringify(json.data, null, 2)}`;
}

async function runTool(path, query) {
  const err = credsError();
  if (err) return { content: [{ type: "text", text: err }], isError: true };

  try {
    const json = await daftraGet(path, query);
    return { content: [{ type: "text", text: formatResult(json) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `خطأ أثناء القراءة من Daftra: ${error.message}` }], isError: true };
  }
}

const pageLimitProps = {
  page: { type: "number", description: "رقم الصفحة، الافتراضي 1" },
  limit: { type: "number", description: "عدد العناصر بالصفحة (الحد الأقصى غالبًا 1000)، الافتراضي 20" }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "daftra_get_site_info",
      description: "التحقق من الاتصال بحساب Daftra وعرض معلومات الحساب الأساسية (الاسم، العملة، حالة الاشتراك)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "daftra_get_invoices",
      description: "قراءة قائمة الفواتير من Daftra مع إمكانية التصفية بالتاريخ أو العميل أو حالة الدفع",
      inputSchema: {
        type: "object",
        properties: {
          ...pageLimitProps,
          date_from: { type: "string", description: "بداية مدى تاريخ الفاتورة YYYY-MM-DD" },
          date_to: { type: "string", description: "نهاية مدى تاريخ الفاتورة YYYY-MM-DD" },
          client_id: { type: "number", description: "تصفية حسب رقم العميل" },
          payment_status: { type: "number", description: "-1 مسودة، -2 مستحقة، -3 متأخرة، 0 غير مدفوعة، 1 مدفوعة جزئيًا، 2 مدفوعة، 4 مدفوعة بالزيادة" },
          keywords: { type: "string", description: "بحث حر في اسم العميل أو رقم الفاتورة" },
          recursive: { type: "number", description: "1 لإرجاع تفاصيل البنود والدفعات والضرائب لكل فاتورة" }
        }
      }
    },
    {
      name: "daftra_get_clients",
      description: "قراءة قائمة العملاء المسجّلين في Daftra",
      inputSchema: {
        type: "object",
        properties: {
          ...pageLimitProps,
          keywords: { type: "string", description: "بحث بالاسم أو البريد أو رقم الهاتف أو رقم العميل" },
          assign_staff_id: { type: "number", description: "تصفية حسب الموظف المسؤول عن العميل" }
        }
      }
    },
    {
      name: "daftra_get_expenses",
      description: "قراءة قائمة المصروفات المسجّلة في Daftra",
      inputSchema: {
        type: "object",
        properties: {
          ...pageLimitProps,
          date_from: { type: "string", description: "بداية مدى تاريخ المصروف YYYY-MM-DD" },
          date_to: { type: "string", description: "نهاية مدى تاريخ المصروف YYYY-MM-DD" },
          id: { type: "number", description: "تصفية برقم مصروف محدد" },
          expense_number: { type: "string", description: "تصفية برقم/مرجع المصروف" },
          sort: { type: "string", description: "الترتيب حسب حقل معين (date, amount, id)" },
          direction: { type: "string", description: "asc أو desc" }
        }
      }
    },
    {
      name: "daftra_get_invoice_payments",
      description: "قراءة قائمة مدفوعات الفواتير المسجّلة في Daftra",
      inputSchema: {
        type: "object",
        properties: {
          ...pageLimitProps,
          sort: { type: "string", description: "الترتيب حسب حقل معين (date, amount)" },
          direction: { type: "string", description: "asc أو desc" },
          include_starting_balance: { type: "number", description: "1 لتضمين دفعات الرصيد الافتتاحي (مستبعدة افتراضيًا)" }
        }
      }
    },
    {
      name: "daftra_get_journals",
      description: "قراءة قيود اليومية (القيود المحاسبية) المسجّلة في Daftra",
      inputSchema: {
        type: "object",
        properties: {
          ...pageLimitProps,
          description: { type: "string", description: "بحث نصي في وصف القيد" },
          number: { type: "string", description: "تصفية برقم القيد (مطابقة جزئية)" },
          draft: { type: "number", description: "0 = معتمد، 1 = مسودة" }
        }
      }
    },
    {
      name: "daftra_get_journal_accounts",
      description: "قراءة دليل الحسابات (شجرة الحسابات) مع أرصدتها (مدين/دائن/صافي) — أقرب مكافئ متاح لميزان المراجعة عبر الـ API",
      inputSchema: {
        type: "object",
        properties: {
          ...pageLimitProps,
          journal_cat_id: { type: "number", description: "تصفية حسب تصنيف/مجموعة حسابات معينة" },
          has_cost_centers: { type: "number", description: "1 = حسابات لها مراكز تكلفة فقط، 0 = بدون" }
        }
      }
    },
    {
      name: "daftra_get_treasuries",
      description: "قراءة الخزائن والحسابات البنكية في Daftra مع أرصدتها الحالية",
      inputSchema: { type: "object", properties: { ...pageLimitProps } }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args || {};

  switch (name) {
    case "daftra_get_site_info":
      return runTool("/site_info", {});
    case "daftra_get_invoices":
      return runTool("/invoices", a);
    case "daftra_get_clients":
      return runTool("/clients", a);
    case "daftra_get_expenses":
      return runTool("/expenses", a);
    case "daftra_get_invoice_payments":
      return runTool("/invoice_payments", a);
    case "daftra_get_journals":
      return runTool("/journals", a);
    case "daftra_get_journal_accounts":
      return runTool("/journal_accounts", a);
    case "daftra_get_treasuries":
      return runTool("/treasuries", a);
    default:
      return { content: [{ type: "text", text: `أداة غير معروفة: ${name}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
