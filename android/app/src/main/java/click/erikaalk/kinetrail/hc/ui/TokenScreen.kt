package click.erikaalk.kinetrail.hc.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import click.erikaalk.kinetrail.hc.designsystem.KtSpacing
import click.erikaalk.kinetrail.hc.designsystem.KtType
import click.erikaalk.kinetrail.hc.designsystem.component.PageTitle
import click.erikaalk.kinetrail.hc.designsystem.component.PrimaryButton
import click.erikaalk.kinetrail.hc.designsystem.component.SectionFooter
import click.erikaalk.kinetrail.hc.designsystem.ktColors

@Composable
fun TokenScreen(actions: AppActions, insets: PageInsets) {
    var token by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(top = insets.top, bottom = insets.bottom),
    ) {
        PageTitle(text = Screen.Token.title, onTitleBounds = insets.onTitleBounds)
        OutlinedTextField(
            value = token,
            onValueChange = { token = it.trim(); error = null },
            label = { Text("推送令牌") },
            singleLine = true,
            isError = error != null,
            supportingText = error?.let { { Text(it, style = KtType.secondary) } },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            textStyle = KtType.body.copy(color = ktColors.text.primary),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = KtSpacing.Padding.pageX)
                .padding(top = KtSpacing.pageTitleToSection),
        )
        SectionFooter("保存后用本机 Android Keystore 加密，替换已保存的令牌。")
        PrimaryButton(
            text = "保存",
            enabled = token.isNotEmpty(),
            onClick = { if (!actions.saveToken(token)) error = "令牌太短，没有保存" },
            modifier = Modifier.padding(horizontal = KtSpacing.Padding.pageX).padding(top = KtSpacing.Gap.section),
        )
    }
}
